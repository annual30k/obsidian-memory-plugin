#!/usr/bin/env node
/**
 * Offline replay of the session digest: what would automatic capture have staged from real past sessions,
 * with today's keyword/Laya selection versus an LLM extraction pass run through the host's own CLI?
 *
 *   node scripts/replay-digest.mjs build    [--from 2026-09-01] [--to 2026-10-01] [--run sep]
 *   node scripts/replay-digest.mjs baseline [--run sep]          today's digest (needs the Laya service)
 *   node scripts/replay-digest.mjs extract  [--run sep] [--tag v2] [--limit N] [--concurrency 2]   LLM extraction
 *   node scripts/replay-digest.mjs pool     [--run sep] [--systems llm,llm-v2]   blind, shuffled candidates for judging
 *   node scripts/replay-digest.mjs report   [--run sep] [--pool pool]   scores once <pool>/judgments/*.jsonl exist
 *
 * Everything lives in ~/.laya/replay/<run>/ (private, 0700). The baseline runs the real router and digest
 * code in dry-run mode against an isolated state folder, so nothing is written to the Vault, the real
 * capture queue, session state or decision log. Extraction calls run with the plugin's hooks off.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { layaHome } from "../lib/memory-router/paths.js";
import { redactSecrets } from "../lib/memory-router/fast-path.js";
import { resolveProjectIdFromCwd } from "../lib/memory-router/vault-index.js";
import { defaultServiceFilePath } from "../lib/config.js";
import { extractSession, runCodexExtraction, codexUserModel } from "../lib/memory-router/llm-extract.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { cmd: argv[0] ?? "help", run: "sep", tag: null, systems: null, pool: "pool", from: "2026-09-01", to: "2026-10-01", limit: null, concurrency: 2, vault: null, codexHome: null, sessions: null, force: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--run") args.run = next();
    else if (a === "--from") args.from = next();
    else if (a === "--to") args.to = next();
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--vault") args.vault = next();
    else if (a === "--codex-home") args.codexHome = next();
    else if (a === "--session") (args.sessions ??= []).push(next());
    else if (a === "--force") args.force = true;
    else if (a === "--tag") args.tag = next();
    else if (a === "--pool") args.pool = next();
    else if (a === "--systems") args.systems = next().split(",");
  }
  return args;
}

export function runDir(run) {
  const dir = path.join(layaHome(), "replay", run);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
}

function defaultVault() {
  return process.env.OBSIDIAN_MEMORY_VAULT || path.join(os.homedir(), "Obsidian", "Workspace");
}

// ---------------------------------------------------------------- build: real sessions -> turns

// Codex wraps the user's words when files or images are attached; only the request itself counts.
export function codexUserText(content) {
  const text = (Array.isArray(content) ? content : [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  const marker = text.lastIndexOf("## My request:");
  return (marker >= 0 ? text.slice(marker + "## My request:".length) : text).trim();
}

/**
 * One Codex rollout -> { id, cwd, model, turns: [{ id, ts, prompt, reply }] } for a session the user started
 * (subagent threads are skipped: their "user" is another agent). A turn is the user's message and the
 * agent's final message of that task. Forked threads repeat their parent's turns; callers dedupe by turn id.
 */
export function parseCodexRollout(file) {
  let meta = null;
  let prompt = null;
  let fresh = false;
  const turns = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload ?? {};
    if (o.type === "session_meta" && !meta) meta = p;
    if (o.type !== "event_msg") continue;
    if (p.type === "item_completed" && p.item?.type === "UserMessage") {
      const text = codexUserText(p.item.content);
      if (text) { prompt = text; fresh = true; }
    } else if (p.type === "task_complete" && typeof p.last_agent_message === "string" && p.last_agent_message.trim()) {
      // A task with no new user message (goal continuation, after compaction) keeps the last request, as the
      // Stop hook does (it reads the request from the session state of the last prompt).
      turns.push({ id: p.turn_id ?? `${turns.length}`, ts: o.timestamp, prompt: prompt ?? "", reply: p.last_agent_message.trim(), ...(fresh ? {} : { continued: true }) });
      fresh = false;
    }
  }
  if (!meta || meta.thread_source !== "user") return null;
  return { id: meta.id, cwd: meta.cwd ?? null, turns };
}

function listFiles(dir, re) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function clean(text, max) {
  const { text: out, redacted } = redactSecrets(String(text ?? ""));
  return { text: out.length > max ? out.slice(0, max) + "…" : out, redacted };
}

export function buildCodexSessions({ codexHome, from, to, vaultPath }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const seenTurns = new Set();
  const sessions = [];
  for (const file of listFiles(path.join(codexHome, "sessions"), /^rollout-.*\.jsonl$/u)) {
    const parsed = parseCodexRollout(file);
    if (!parsed) continue;
    const turns = [];
    for (const t of parsed.turns) {
      const ms = Date.parse(t.ts);
      if (!(ms >= fromMs && ms < toMs) || seenTurns.has(t.id)) continue;
      seenTurns.add(t.id);
      const prompt = clean(t.prompt, 4000);
      const reply = clean(t.reply, 8000);
      turns.push({ ts: t.ts, prompt: prompt.text, reply: reply.text, ...(t.continued ? { continued: true } : {}), ...(prompt.redacted || reply.redacted ? { redacted: true } : {}) });
    }
    if (!turns.length) continue;
    sessions.push({
      session: crypto.createHash("sha256").update(`codex:${parsed.id}`).digest("hex").slice(0, 16),
      host: "codex", sessionKey: parsed.id, cwd: parsed.cwd, vaultPath,
      projectId: resolveProjectIdFromCwd(vaultPath, parsed.cwd), turns
    });
  }
  return sessions;
}

function cmdBuild(args) {
  const dir = runDir(args.run);
  const vaultPath = args.vault ?? defaultVault();
  const codexHome = args.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sessions = buildCodexSessions({ codexHome, from: args.from, to: args.to, vaultPath });
  writeJsonl(path.join(dir, "sessions.jsonl"), sessions);
  const turns = sessions.reduce((n, s) => n + s.turns.length, 0);
  const byProject = {};
  for (const s of sessions) byProject[s.projectId ?? "(none)"] = (byProject[s.projectId ?? "(none)"] ?? 0) + 1;
  console.log(`sessions: ${sessions.length}, turns: ${turns}, written to ${path.join(dir, "sessions.jsonl")}`);
  console.log("sessions per project:", JSON.stringify(byProject));
}

// ---------------------------------------------------------------- baseline: today's digest, dry run

/**
 * Feed every session through the same code the Codex hooks run (router.evaluateRecall for the prompt, which
 * queues statements / "solved" / explicit requests, then enqueueTurnEnd for the reply) on a clock set to the
 * turn's time, then digest everything in dry-run mode. All state goes to <run>/baseline-home; the live
 * Laya service does the scoring. Known difference from live: an explicit "记住" the agent did stage back then
 * is not seen as staged (the Vault has changed since), so it is queued as an explicit record.
 */
async function cmdBaseline(args) {
  const dir = runDir(args.run);
  const sessions = readJsonl(path.join(dir, "sessions.jsonl"));
  const realHome = layaHome();
  const serviceFile = defaultServiceFilePath();
  const home = path.join(dir, "baseline-home");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Reuse the Vault index and note vectors instead of embedding the whole Vault again.
  try { fs.cpSync(path.join(realHome, "cache"), path.join(home, "cache"), { recursive: true }); } catch {}
  Object.assign(process.env, {
    OBSIDIAN_MEMORY_LAYA_DIR: home, OBSIDIAN_MEMORY_SERVICE_FILE: serviceFile,
    OBSIDIAN_MEMORY_DIGEST: "off", OBSIDIAN_MEMORY_DECISION_LOG: "off"
  });
  const { memoryJudgeFromEnv } = await import("../lib/config.js");
  const { createMemoryRouter } = await import("../lib/memory-router/router.js");
  const { enqueueTurnEnd } = await import("../lib/memory-router/turn-context.js");
  const { runDigest } = await import("../lib/memory-router/digest.js");
  const { captureQueueDir } = await import("../lib/memory-router/paths.js");

  // Real time until the replay starts (waiting for the model), then the turn's time.
  let clockMs = null;
  const config = memoryJudgeFromEnv(process.env, { mode: "auto", autoCapture: "digest" });
  const router = createMemoryRouter(config, { clock: () => clockMs ?? Date.now(), useCache: false });
  const routes = {};
  try {
    if (!(await router.ensureModelReady({ waitMs: 60000 }))) throw new Error("Laya service not ready: start it with `node scripts/laya-service.mjs start`");
    let lastMs = 0;
    for (const [n, s] of sessions.entries()) {
      if (args.sessions && !args.sessions.includes(s.session)) continue;
      let prevMs = 0;
      for (const t of s.turns) {
        const ms = Date.parse(t.ts);
        // The prompt arrived some time before the reply; after the previous turn either way.
        clockMs = Math.max(prevMs + 1, ms - 1000);
        // A continuation task had no new prompt: no UserPromptSubmit, only the Stop hook.
        if (!t.continued && t.prompt) {
          const d = await router.evaluateRecall(t.prompt, null, { host: s.host, sessionKey: s.sessionKey, cwd: s.cwd, vaultPath: s.vaultPath });
          const route = `${d.trace?.route ?? "?"}:${d.reason ?? "?"}`;
          routes[route] = (routes[route] ?? 0) + 1;
        }
        clockMs = ms;
        enqueueTurnEnd({ host: s.host, sessionKey: s.sessionKey, assistantText: t.reply, now: ms, env: { OBSIDIAN_MEMORY_DIGEST: "off" } });
        prevMs = ms;
        lastMs = Math.max(lastMs, ms);
      }
      process.stderr.write(`\rqueued ${n + 1}/${sessions.length}`);
    }
    process.stderr.write("\n");
    console.log("prompt routes:", JSON.stringify(routes));
    const summary = await runDigest({
      force: true, dryRun: true, now: lastMs + DAY_MS,
      queueDir: captureQueueDir(), stateDir: path.join(home, "state"), logPath: path.join(home, "digest-log.jsonl"),
      score: (text) => router.captureScoreFor(text),
      embed: (texts, kind) => router.embedTexts(texts, kind)
    });
    const out = [
      ...summary.written.map((w) => ({ session: w.session, system: "baseline", kind: w.kind, scope: "project", text: candidateEvidence(w.content) })),
      ...summary.held.map((h) => ({ session: h.session, system: "baseline", kind: h.kind, scope: "hold", text: h.text }))
    ];
    writeJsonl(path.join(dir, "baseline.jsonl"), out);
    const reasons = {};
    for (const r of summary.skipped) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    console.log(`baseline: ${summary.processed} sessions, ${summary.written.length} candidates, ${summary.held.length} held; skipped ${JSON.stringify(reasons)}`);
  } finally {
    router.dispose();
  }
}

// The evidence section of a rendered candidate (what a reviewer actually reads), without the frontmatter.
export function candidateEvidence(content) {
  const text = String(content ?? "");
  const m = /\n## (?:Candidate|Original) evidence\s*\n([\s\S]*?)(?:\n## |$)/u.exec(text);
  return (m ? m[1] : text.replace(/^---[\s\S]*?\n---\n/u, "")).trim();
}

// ---------------------------------------------------------------- extract: LLM pass per session

const RUNNERS = { codex: runCodexExtraction };

/**
 * Run the extraction for every session through its host's CLI. Resumable: sessions already in
 * <system>-runs.jsonl are skipped unless --force. One row per run there, one per item in <system>.jsonl.
 */
async function cmdExtract(args) {
  const dir = runDir(args.run);
  const sessions = readJsonl(path.join(dir, "sessions.jsonl")).filter((s) => !args.sessions || args.sessions.includes(s.session));
  // --tag keeps a variant's results apart (llm-v2.jsonl, system "llm-v2") so variants can be judged side by side.
  const system = args.tag ? `llm-${args.tag}` : "llm";
  const runsFile = path.join(dir, `${system}-runs.jsonl`);
  const itemsFile = path.join(dir, `${system}.jsonl`);
  if (args.force) { fs.rmSync(runsFile, { force: true }); fs.rmSync(itemsFile, { force: true }); }
  const done = new Set(readJsonl(runsFile).filter((r) => !r.error).map((r) => r.session));
  const todo = sessions.filter((s) => !done.has(s.session)).slice(0, args.limit ?? Infinity);
  const { model, effort } = codexUserModel();
  console.log(`extracting ${todo.length} sessions (${done.size} done) with codex ${model ?? "(default model)"} / ${effort ?? "default effort"}`);
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++];
      const run = RUNNERS[s.host];
      const t0 = Date.now();
      const row = { session: s.session, host: s.host, turns: s.turns.length, model, effort };
      try {
        if (!run) throw new Error(`no runner for host ${s.host}`);
        const { items, dropped, calls } = await extractSession(s, (prompt) => run(prompt, { model, effort }));
        row.calls = calls;
        row.items = items.length;
        if (dropped.length) row.dropped = dropped;
        const lines = items.map((it) => JSON.stringify({
          session: s.session, system, kind: it.kind, scope: s.projectId || it.scope === "global" ? it.scope : "hold",
          title: it.title, text: `${it.statement}\n\nEvidence (turn ${it.turn ?? "?"}): "${it.evidence}"`, item: it
        }) + "\n").join("");
        if (lines) fs.appendFileSync(itemsFile, lines, { mode: 0o600 });
      } catch (err) {
        row.error = String(err?.message ?? err).slice(0, 300);
      }
      row.secs = Math.round((Date.now() - t0) / 100) / 10;
      fs.appendFileSync(runsFile, JSON.stringify(row) + "\n", { mode: 0o600 });
      finished++;
      console.log(`[${finished}/${todo.length}] ${s.session} turns=${s.turns.length} ${row.error ? `ERROR ${row.error}` : `items=${row.items}`} ${row.secs}s`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
}

// ---------------------------------------------------------------- pool: blind packets for judging

// Explicit "记住" requests stay on the in-turn path under both designs, so they are not compared here.
const COMPARED_KINDS = new Set(["turn", "statement", ...["decision", "convention", "preference", "pitfall", "fact"]]);

function transcriptText(s) {
  return s.turns.map((t, i) => {
    const request = t.continued ? "(continued the previous request)" : (t.prompt.length > 1500 ? `${t.prompt.slice(0, 1500)} …` : t.prompt);
    const reply = t.reply.length > 3000 ? `${t.reply.slice(0, 3000)} …` : t.reply;
    return `### Turn ${i + 1} (${t.ts})\nUser: ${request}\n\nAgent: ${reply}\n`;
  }).join("\n");
}

function shuffled(list, seed) {
  const out = [...list];
  let h = crypto.createHash("sha256").update(seed).digest();
  for (let i = out.length - 1; i > 0; i--) {
    if (i % 16 === 0) h = crypto.createHash("sha256").update(h).digest();
    const j = h[i % 32] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * One packet per session that has at least one candidate from either system: the transcript and the
 * candidates in a seeded random order under neutral letters. key.jsonl maps letters back to systems.
 * Batches of roughly equal size go to separate judges.
 */
function cmdPool(args) {
  const dir = runDir(args.run);
  const sessions = new Map(readJsonl(path.join(dir, "sessions.jsonl")).map((s) => [s.session, s]));
  const systems = args.systems ?? ["baseline", "llm"];
  const all = systems.flatMap((sys) => readJsonl(path.join(dir, `${sys}.jsonl`)));
  const compared = all.filter((c) => COMPARED_KINDS.has(c.kind));
  const pool = path.join(dir, args.pool);
  fs.rmSync(path.join(pool, "packets"), { recursive: true, force: true });
  fs.mkdirSync(path.join(pool, "packets"), { recursive: true, mode: 0o700 });
  const key = [];
  const packets = [];
  const bySession = new Map();
  for (const c of compared) (bySession.get(c.session) ?? bySession.set(c.session, []).get(c.session)).push(c);
  for (const [session, cands] of bySession) {
    const s = sessions.get(session);
    if (!s) continue;
    const order = shuffled(cands, `${args.run}:${session}`);
    const letters = order.map((_, i) => String.fromCharCode(65 + i));
    order.forEach((c, i) => key.push({ session, letter: letters[i], system: c.system, kind: c.kind, scope: c.scope }));
    const body = [
      `# Session ${session}`, "", `Host: ${s.host}. Project: ${s.projectId ?? "(none)"}. Turns: ${s.turns.length}.`, "",
      "## Candidates", "",
      ...order.flatMap((c, i) => [`### Candidate ${letters[i]}`, "", c.text.trim(), ""]),
      "## Transcript", "", transcriptText(s)
    ].join("\n");
    const file = path.join(pool, "packets", `${session}.md`);
    fs.writeFileSync(file, body, { mode: 0o600 });
    packets.push({ session, file, chars: body.length, candidates: order.length });
  }
  writeJsonl(path.join(pool, "key.jsonl"), key);
  // Greedy balance into batches of ~120k characters.
  const batches = [];
  for (const p of [...packets].sort((a, b) => b.chars - a.chars)) {
    let home = batches.find((b) => b.chars + p.chars <= 120000);
    if (!home) batches.push(home = { chars: 0, sessions: [] });
    home.chars += p.chars;
    home.sessions.push(p.session);
  }
  fs.writeFileSync(path.join(pool, "batches.json"), JSON.stringify(batches, null, 1), { mode: 0o600 });
  const counts = {};
  for (const k of key) counts[k.system] = (counts[k.system] ?? 0) + 1;
  console.log(`packets: ${packets.length}, candidates: ${JSON.stringify(counts)}, batches: ${batches.length} (${batches.map((b) => b.sessions.length).join(", ")} sessions)`);
}

// ---------------------------------------------------------------- report

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");

/**
 * Join judgments (pool/judgments/*.jsonl, one row per candidate: { session, letter, score 0|1|2, faithful,
 * group }) with the key. A "useful memory" is a group with a candidate scored 2; pooled recall is the
 * share of those groups a system found (plus groups the judge listed as missed by everyone).
 */
function cmdReport(args) {
  const dir = runDir(args.run);
  const pool = path.join(dir, args.pool);
  const key = new Map(readJsonl(path.join(pool, "key.jsonl")).map((k) => [`${k.session}:${k.letter}`, k]));
  const jdir = path.join(pool, "judgments");
  const judged = [];
  const missed = [];
  for (const f of fs.existsSync(jdir) ? fs.readdirSync(jdir).filter((n) => n.endsWith(".jsonl")) : []) {
    for (const r of readJsonl(path.join(jdir, f))) {
      if (r.missed) { missed.push(r); continue; }
      const k = key.get(`${r.session}:${r.letter}`);
      if (k) judged.push({ ...k, ...r });
    }
  }
  const systems = [...new Set([...key.values()].map((k) => k.system))].sort();
  const lines = [`judged ${judged.length}/${key.size} candidates; missed-by-all memories listed: ${missed.length}`, ""];
  const usefulGroups = new Map();
  for (const j of judged) if (j.score === 2 && j.group) {
    const g = `${j.session}:${j.group}`;
    (usefulGroups.get(g) ?? usefulGroups.set(g, new Set()).get(g)).add(j.system);
  }
  const totalUseful = usefulGroups.size + missed.length;
  lines.push("| system | candidates | useful (2) | marginal (1) | junk (0) | unfaithful | useful memories found | pooled recall |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const sys of systems) {
    const mine = judged.filter((j) => j.system === sys);
    const by = (v) => mine.filter((j) => j.score === v).length;
    const found = [...usefulGroups.values()].filter((set) => set.has(sys)).length;
    lines.push(`| ${sys} | ${mine.length} | ${by(2)} (${pct(by(2), mine.length)}) | ${by(1)} | ${by(0)} (${pct(by(0), mine.length)}) | ${mine.filter((j) => j.faithful === false).length} | ${found} | ${pct(found, totalUseful)} |`);
  }
  lines.push("", `useful memories in total: ${totalUseful} (${usefulGroups.size} found by some system, ${missed.length} missed by both)`);
  const kinds = {};
  for (const j of judged) {
    const k = `${j.system}/${j.kind}`;
    kinds[k] ??= [0, 0, 0];
    kinds[k][j.score]++;
  }
  lines.push("", "by kind (junk / marginal / useful):", ...Object.entries(kinds).sort().map(([k, v]) => `  ${k}: ${v.join(" / ")}`));
  for (const sys of systems.filter((x) => x !== "baseline")) {
    const runs = readJsonl(path.join(dir, `${sys}-runs.jsonl`));
    if (!runs.length) continue;
    const ok = runs.filter((r) => !r.error);
    const secs = ok.map((r) => r.secs).sort((a, b) => a - b);
    lines.push("", `${sys} runs: ${ok.length} ok, ${runs.length - ok.length} failed; median ${secs[Math.floor(secs.length / 2)] ?? "-"}s, p90 ${secs[Math.floor(secs.length * 0.9)] ?? "-"}s; sessions with 0 items: ${ok.filter((r) => r.items === 0).length}; calls: ${ok.reduce((n, r) => n + (r.calls ?? 1), 0)}`);
  }
  const text = lines.join("\n");
  fs.writeFileSync(path.join(dir, "report.md"), text + "\n", { mode: 0o600 });
  console.log(text);
}

// ---------------------------------------------------------------- main

const COMMANDS = { build: cmdBuild, baseline: cmdBaseline, extract: cmdExtract, pool: cmdPool, report: cmdReport };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[args.cmd];
  if (!fn) {
    console.log("usage: node scripts/replay-digest.mjs build|baseline|extract|pool|report [--run name]");
    process.exitCode = args.cmd === "help" ? 0 : 2;
    return;
  }
  await fn(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
