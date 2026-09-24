#!/usr/bin/env node
/**
 * End-to-end verification and benchmark for the Laya memory judge.
 *
 * Starts a PRIVATE Laya instance (its own temp HOME, service file and socket, short idle
 * window) so your normal ~/.laya service is untouched, then measures:
 *   1. service start time and initial model status (lazy load?)
 *   2. first inference (model load + inference) and warm inference latency
 *   3. idle unload (does /health report "unloaded"?) and reload latency after unload
 *   4. each host adapter (Codex, Antigravity, Hermes, OpenClaw) with mode off vs auto:
 *      does it inject recall/capture guidance, and how long does the hook take
 *   5. recall accuracy: Fast-Path only (no Laya) vs Fast-Path + Laya
 *
 * Usage (real model, after `npm run laya:install`):
 *   npm run laya:bench
 *   node scripts/bench-laya.mjs --idle 20 --warm 20 --json
 * Mechanics-only run without a model (keyword mock backend, simulated load delay):
 *   node scripts/bench-laya.mjs --backend mock --mock-load-delay 1.5
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readTrustedServiceFile } from "../lib/memory-router/security.js";
import { LayaClient } from "../lib/memory-router/client.js";
import { parseMemoryJudgeConfig } from "../lib/config.js";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { evaluateFastPath } from "../lib/memory-router/fast-path.js";
import { createOpenClawPlugin } from "../index.js";
import { findPython } from "./python.mjs";
import { computeMetrics, loadDataset } from "./eval-laya.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVICE_PY = path.join(ROOT, "lib", "laya-service", "service.py");
const DATASET = path.join(ROOT, "tests", "fixtures", "laya-recall-eval.jsonl");

const HOST_PROMPTS = [
  { id: "greeting", text: "你好", expect: "none (fast-path skip)" },
  { id: "explicit_recall", text: "回忆一下之前数据库连接池的决策", expect: "recall (fast-path)" },
  // No trigger phrase on purpose: this one must be decided by the model, not the fast path.
  { id: "implicit_recall", text: "支付回调当时为什么改成异步处理", expect: "recall (needs Laya)" },
  { id: "self_contained", text: "解释一下 JavaScript 里的事件循环", expect: "none (needs Laya)" },
  { id: "pitfall_capture", text: "这次踩坑的原因是 Windows 路径大小写，记录一下", expect: "capture (fast-path)" }
];

function parseArgs(argv) {
  const args = { backend: "auto", idle: 20, warm: 20, hostRepeats: 3, json: false, mockLoadDelay: 0, python: null, keep: false, preload: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--backend") args.backend = next();
    else if (a === "--idle") args.idle = Number(next());
    else if (a === "--warm") args.warm = Number(next());
    else if (a === "--host-repeats") args.hostRepeats = Number(next());
    else if (a === "--mock-load-delay") args.mockLoadDelay = Number(next());
    else if (a === "--python") args.python = next();
    else if (a === "--json") args.json = true;
    else if (a === "--keep") args.keep = true;
    else if (a === "--no-preload") args.preload = false;
    else if (a === "--vault" && argv[i + 1]) args.vault = path.resolve(argv[++i]);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BENCH_VAULT = null;
const round = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
function stats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: round(s.reduce((a, b) => a + b, 0) / s.length), p50: round(q(0.5)), p95: round(q(0.95)), min: round(s[0]), max: round(s[s.length - 1]) };
}

function resolvePython(args) {
  if (args.python) return { command: args.python, args: ["-B"] };
  const venvPy = process.platform === "win32"
    ? path.join(os.homedir(), ".laya", "venv", "Scripts", "python.exe")
    : path.join(os.homedir(), ".laya", "venv", "bin", "python");
  if (args.backend !== "mock" && existsSync(venvPy)) return { command: venvPy, args: ["-B"] };
  if (args.backend !== "mock") throw new Error(`Laya venv not found at ${venvPy}. Run "npm run laya:install" first, or use --backend mock.`);
  return findPython();
}

async function startPrivateService(args, home) {
  const layaDir = path.join(home, ".laya");
  mkdirSync(layaDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(layaDir, 0o700);
  const serviceFile = path.join(layaDir, "service.json");
  const tokenFile = path.join(layaDir, ".bench-token");
  writeFileSync(tokenFile, `${Math.random().toString(36).slice(2)}${Date.now()}\n`, { mode: 0o600 });
  const py = resolvePython(args);
  const pyArgs = [...py.args, SERVICE_PY, "--backend", args.backend, "--idle-unload-seconds", String(args.idle),
    "--service-file", serviceFile, "--token-file", tokenFile, "--transport", process.platform === "win32" ? "http" : "uds"];
  if (process.platform !== "win32") pyArgs.push("--socket-file", path.join(layaDir, "service.sock"));
  if (args.preload) pyArgs.push("--preload"); // same default as `laya start`
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  if (args.mockLoadDelay) env.LAYA_MOCK_LOAD_DELAY = String(args.mockLoadDelay);
  const t0 = performance.now();
  const child = spawn(py.command, pyArgs, { stdio: ["ignore", "ignore", "pipe"], env, windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  for (let waited = 0; waited < 60000; waited += 50) {
    const info = readTrustedServiceFile(serviceFile);
    if (info) {
      const client = new LayaClient(info.endpoint, { token: info.token });
      try {
        const health = await client.healthCheck({ timeout: 1000 });
        return { child, client, serviceFile, startMs: performance.now() - t0, health };
      } catch {}
    }
    if (child.exitCode !== null) throw new Error(`Laya service exited: ${stderr.slice(-500)}`);
    await sleep(50);
  }
  child.kill();
  throw new Error("Laya service did not become healthy within 60s");
}

async function timedJudge(client, text, timeout = 120000) {
  const t = performance.now();
  const res = await client.judgeRecall({ text, timeout });
  return { ms: performance.now() - t, res };
}

function hostEnv(home, mode, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, PYTHONDONTWRITEBYTECODE: "1", ...extra };
  delete env.XDG_CACHE_HOME;
  delete env.LAYA_HOME;
  delete env.CODEX_HOME;
  delete env.OBSIDIAN_MEMORY_VAULT;
  // --vault: host hooks also run the Vault-hint layer (read-only), so its cost is measured too.
  if (BENCH_VAULT) env.OBSIDIAN_MEMORY_VAULT = BENCH_VAULT;
  env.OBSIDIAN_MEMORY_JUDGE_MODE = mode;
  env.OBSIDIAN_MEMORY_ROUTER_MODE = mode;
  env.OBSIDIAN_MEMORY_SERVICE_FILE = path.join(home, ".laya", "service.json");
  return env;
}

function classify(text) {
  if (!text) return "none";
  if (/recall recommended/.test(text)) return "recall";
  if (/high-value/.test(text)) return "capture";
  if (/routing fallback/.test(text)) return "fallback";
  return "none";
}

function runCodex(home, mode, prompt) {
  const t = performance.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "codex-hook.mjs")], { input: JSON.stringify({ prompt }), env: hostEnv(home, mode), encoding: "utf8", timeout: 20000 });
  const ms = performance.now() - t;
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  let route = "unknown";
  for (const line of (r.stderr || "").split("\n")) {
    try { const t = JSON.parse(line); if (t && t.route) route = t.route; } catch {}
  }
  return { ms, route, injected: classify(out.hookSpecificOutput?.additionalContext), blocked: out.decision === "block" };
}

let agyTurn = 0;
function runAntigravity(home, mode, prompt) {
  const t = performance.now();
  const payload = { conversationId: `bench-${process.pid}-${Date.now()}-${agyTurn}`, invocationNum: agyTurn++, prompt };
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "antigravity-hook.mjs")], { input: JSON.stringify(payload), env: hostEnv(home, mode), encoding: "utf8", timeout: 20000 });
  const ms = performance.now() - t;
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  return { ms, injected: classify(out.injectSteps?.[0]?.ephemeralMessage), blocked: false };
}

function runHermes(home, mode, prompt, py) {
  // Hermes is a long-lived process: time only the pre_llm_call hook, not Python startup.
  const program = [
    "import importlib.util, json, sys, time",
    "spec = importlib.util.spec_from_file_location('omp_bench', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "t = time.perf_counter(); r = m.on_pre_llm_call(None, user_message=sys.argv[2]); ms = (time.perf_counter() - t) * 1000",
    "print(json.dumps({'ms': ms, 'context': r.get('context')}))"
  ].join("\n");
  const r = spawnSync(py.command, [...py.args, "-c", program, path.join(ROOT, "__init__.py"), prompt], { env: hostEnv(home, mode), encoding: "utf8", timeout: 20000 });
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  return { ms: out.ms ?? NaN, injected: classify(out.context), blocked: false };
}

function makeOpenClaw(home, mode, serviceFile) {
  const handlers = {};
  const plugin = createOpenClawPlugin();
  plugin.register({
    pluginConfig: { agentId: "main", vaultPath: home, memoryJudge: { mode, serviceFile } },
    logger: {},
    on: (name, fn) => { handlers[name] = fn; },
    onDispose: (fn) => { handlers.dispose = fn; }
  });
  let run = 0;
  return {
    async call(prompt) {
      const t = performance.now();
      const res = await handlers.before_prompt_build?.({ prompt }, { agentId: "main", runId: `bench-${run++}`, trigger: "user" });
      const ms = performance.now() - t;
      const ctx = res?.prependContext ?? "";
      return { ms, injected: classify(ctx.split("\n").find((l) => l.startsWith("[Laya")) ?? ""), blocked: false };
    },
    dispose() { handlers.dispose?.(); }
  };
}

async function waitForUnload(client, idleSeconds) {
  const t = performance.now();
  const limit = (idleSeconds + Math.max(1, Math.min(30, idleSeconds / 4)) + 10) * 1000;
  while (performance.now() - t < limit) {
    const h = await client.healthCheck({ timeout: 1000 });
    if (h.modelStatus === "unloaded") return { unloaded: true, afterMs: performance.now() - t };
    await sleep(500);
  }
  return { unloaded: false, afterMs: performance.now() - t };
}

export async function runBench(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  BENCH_VAULT = args.vault ?? null;
  const log = (s) => { if (!args.json) process.stdout.write(s + "\n"); };
  const home = mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "laya-bench-"));
  const py = resolvePython(args);
  const report = { backend: args.backend, idleUnloadSeconds: args.idle, platform: `${process.platform}-${process.arch}` };
  let svc;
  try {
    log(`Starting private Laya instance (backend=${args.backend}, idle unload=${args.idle}s)...`);
    svc = await startPrivateService(args, home);
    report.backendActual = svc.health.backend ?? args.backend;
    report.service = { startMs: round(svc.startMs), initialModelStatus: svc.health.modelStatus };
    log(`  service ready in ${round(svc.startMs)} ms, initial model_status=${svc.health.modelStatus}`);

    // 1. Background preload (default, like `laya start`): time until /health reports ready
    if (args.preload) {
      const t = performance.now();
      let status = svc.health.modelStatus;
      while (status !== "ready" && performance.now() - t < 120000) {
        await sleep(100);
        status = (await svc.client.healthCheck({ timeout: 1000 })).modelStatus;
      }
      report.preload = { readyAfterStartMs: round(svc.startMs + performance.now() - t), modelStatus: status };
      log(`  background preload: model ready ${report.preload.readyAfterStartMs} ms after launch (no request needed)`);
    }

    // First inference (includes lazy model load when --no-preload)
    const first = await timedJudge(svc.client, "按我们项目的惯例，新接口的错误码应该怎么定义");
    const afterFirst = await svc.client.healthCheck({ timeout: 1000 });
    report.firstInference = { ms: round(first.ms), modelStatusAfter: afterFirst.modelStatus };
    log(`  first inference ${round(first.ms)} ms -> model_status=${afterFirst.modelStatus}`);

    // 2. Warm inference
    const dataset = loadDataset(DATASET);
    const warm = [];
    for (let i = 0; i < args.warm; i++) warm.push((await timedJudge(svc.client, dataset[i % dataset.length].text)).ms);
    report.warmInference = stats(warm);
    log(`  warm inference x${args.warm}: p50 ${report.warmInference.p50} ms, p95 ${report.warmInference.p95} ms`);

    // 3. Host adapters, warm model, off vs auto
    report.hosts = {};
    const openclaw = { off: makeOpenClaw(home, "off", svc.serviceFile), auto: makeOpenClaw(home, "auto", svc.serviceFile) };
    const hostRunners = {
      codex: (mode, p) => runCodex(home, mode, p),
      antigravity: (mode, p) => runAntigravity(home, mode, p),
      hermes: (mode, p) => runHermes(home, mode, p, py),
      openclaw: (mode, p) => openclaw[mode].call(p)
    };
    for (const [host, runner] of Object.entries(hostRunners)) {
      report.hosts[host] = {};
      for (const mode of ["off", "auto"]) {
        const times = [];
        const decisions = {};
        for (const prompt of HOST_PROMPTS) {
          for (let r = 0; r < args.hostRepeats; r++) {
            const res = await runner(mode, prompt.text);
            times.push(res.ms);
            if (r === args.hostRepeats - 1) decisions[prompt.id] = res.blocked ? "block" : res.injected;
          }
        }
        report.hosts[host][mode] = { latency: stats(times), decisions };
      }
      const off = report.hosts[host].off.latency.p50;
      const auto = report.hosts[host].auto.latency.p50;
      log(`  ${host.padEnd(11)} off p50 ${String(off).padStart(7)} ms | auto p50 ${String(auto).padStart(7)} ms (+${round(auto - off)} ms) | ${Object.entries(report.hosts[host].auto.decisions).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
    report.hostPrompts = HOST_PROMPTS;

    // 4. Accuracy: Fast-Path only (what the hooks can decide without Laya) vs Fast-Path + Laya
    const router = new MemoryRouter(parseMemoryJudgeConfig({ mode: "auto", serviceFile: svc.serviceFile, timeout: 60000, coldStartTimeout: 120000, healthTimeout: 2000 }), { useCache: false });
    const rows = [];
    const fastOnly = [];
    try {
      for (const item of dataset) {
        const res = await router.evaluateRecall(item.text);
        rows.push({ recall: item.recall, route: res.trace?.route ?? "fallback", recallRecommended: Boolean(res.recallRecommended), score: typeof res.score === "number" ? res.score : null });
        const fast = evaluateFastPath(item.text);
        fastOnly.push({ recall: item.recall, route: "fast_path", recallRecommended: Boolean(fast.recallRecommended), score: null });
      }
    } finally {
      router.dispose();
    }
    report.accuracy = { fastPathOnly: computeMetrics(fastOnly).endToEnd, withLaya: computeMetrics(rows) };
    const fp = report.accuracy.fastPathOnly;
    const wl = report.accuracy.withLaya.endToEnd;
    const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
    log(`  accuracy (n=${dataset.length}): fast-path only recall ${pct(fp.recall)} precision ${pct(fp.precision)} F1 ${pct(fp.f1)} | +Laya recall ${pct(wl.recall)} precision ${pct(wl.precision)} F1 ${pct(wl.f1)}`);

    // 5. Idle unload and reload (hot restart of the model inside the running service)
    log(`  waiting for idle unload (~${args.idle}s)...`);
    const unload = await waitForUnload(svc.client, args.idle);
    report.idleUnload = { unloaded: unload.unloaded, observedAfterMs: round(unload.afterMs) };
    if (unload.unloaded) {
      // Background cold start (default): the cold turn must return at once and trigger a reload.
      // Use a prompt that needs Laya (not a fast-path one) so the cold path is exercised.
      const codexCold = runCodex(home, "auto", HOST_PROMPTS[3].text);
      const tReload = performance.now();
      let afterReload = await svc.client.healthCheck({ timeout: 1000 });
      while (afterReload.modelStatus !== "ready" && performance.now() - tReload < 60000) {
        await sleep(100);
        afterReload = await svc.client.healthCheck({ timeout: 1000 });
      }
      const reloadReadyMs = performance.now() - tReload + codexCold.ms;
      const codexNext = runCodex(home, "auto", "把这段 SQL 改写成使用 JOIN 的形式");
      const warmAgain = await timedJudge(svc.client, HOST_PROMPTS[3].text);
      report.reload = {
        codexHookColdMs: round(codexCold.ms), codexRoute: codexCold.route, codexDecision: codexCold.injected,
        backgroundReloadReadyMs: round(reloadReadyMs), modelStatusAfter: afterReload.modelStatus,
        codexNextTurnMs: round(codexNext.ms), codexNextRoute: codexNext.route, nextWarmInferenceMs: round(warmAgain.ms)
      };
      log(`  unloaded after ${round(unload.afterMs)} ms idle; cold Codex turn ${round(codexCold.ms)} ms (route=${codexCold.route}), background reload ready after ${round(reloadReadyMs)} ms, next Codex turn ${round(codexNext.ms)} ms (route=${codexNext.route}), next warm ${round(warmAgain.ms)} ms`);
      if (codexNext.route !== "laya") log("  NOTE: the turn after the background reload still got no Laya verdict.");
    } else {
      log("  model was NOT unloaded within the expected window");
    }
    openclaw.off.dispose();
    openclaw.auto.dispose();
  } finally {
    if (svc?.child && svc.child.exitCode === null) svc.child.kill("SIGTERM");
    await sleep(300);
    if (!args.keep) rmSync(home, { recursive: true, force: true });
  }
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report;
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) {
  runBench().then(() => process.exit(0), (err) => { process.stderr.write(`bench-laya failed: ${err.message}\n`); process.exit(1); });
}
