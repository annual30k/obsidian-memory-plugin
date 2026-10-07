#!/usr/bin/env node
/**
 * One read-only look at every place this plugin is installed and configured.
 *
 *   npm run doctor            # human-readable report
 *   npm run doctor -- --json  # machine-readable
 *
 * The Vault path is configured per host (each host has its own config format), so it lives in
 * several places. This lists them side by side and flags a disagreement, an outdated plugin copy,
 * a copy linked to a development checkout, Codex hooks that are missing, not approved yet
 * or registered twice, the Laya service state, and the session digest (queue backlog, last run, candidates
 * written). Nothing is written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vaultPathFromRuleText } from "../lib/memory-router/vault-index.js";
import { layaHome } from "../lib/memory-router/paths.js";
import { resolveExtractor, EXTRACTORS } from "../lib/memory-router/llm-extract.js";

const PLUGIN_ID = "obsidian-memory-plugin";

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const physical = (p) => { try { return realpathSync(p); } catch { return p; } };
const DAY_MS = 24 * 60 * 60 * 1000;

const QUEUE_FILE = /^([0-9a-f]{16})(?:\.\d+-\d+\.claimed)?\.jsonl$/u;
const QUEUE_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** Session digest status from ~/.laya (read only: no migration, no lock). */
export function digestStatus(dir, now = Date.now()) {
  const sessions = new Map();
  let oversized = 0;
  try {
    for (const name of fs.readdirSync(path.join(dir, "capture-queue"))) {
      const m = QUEUE_FILE.exec(name);
      if (!m) continue;
      try {
        const st = fs.statSync(path.join(dir, "capture-queue", name));
        sessions.set(m[1], Math.max(sessions.get(m[1]) ?? 0, st.mtimeMs));
        if (!name.includes(".claimed.") && st.size > QUEUE_FILE_MAX_BYTES) oversized++;
      } catch {}
    }
  } catch {}
  const queue = [...sessions.values()];
  const log = (readText(path.join(dir, "digest-log.jsonl")) ?? "").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const runs = log.filter((r) => !r.action);
  const recent = runs.filter((r) => now - Date.parse(r.ts) < 7 * DAY_MS);
  const waiter = readJson(path.join(dir, "state", "digest-waiter.json"));
  let waiterAlive = false;
  if (waiter?.pid) { try { process.kill(waiter.pid, 0); waiterAlive = true; } catch (err) { waiterAlive = err?.code === "EPERM"; } }
  let held = 0;
  try { held = fs.readdirSync(path.join(dir, "state", "held")).filter((n) => /^held-[0-9a-f]{8}\.json$/u.test(n)).length; } catch {}
  const backfill = readJson(path.join(dir, "state", "embed-backfill.json"));
  const index = readJson(path.join(dir, "cache", "vault-index.json"));
  return {
    queuedSessions: queue.length,
    oldestQueuedMs: queue.length ? now - Math.min(...queue) : null,
    oversizedQueues: oversized,
    waiterAlive,
    lastRun: runs.at(-1)?.ts ?? null,
    written7d: recent.reduce((n, r) => n + (Array.isArray(r.written) ? r.written.length : 0), 0),
    errors7d: recent.filter((r) => (r.skipped ?? []).some((x) => String(x).startsWith("error:") || x === "vault_unreadable" || x === "stale_queue_dropped")).length,
    extractFailures7d: recent.filter((r) => r.extractError).length,
    lastExtractError: recent.filter((r) => r.extractError).at(-1)?.extractError ?? null,
    held,
    backfillPausedUntil: typeof backfill?.pausedUntil === "number" && backfill.pausedUntil > now ? new Date(backfill.pausedUntil).toISOString() : null,
    indexTruncated: index?.truncated && typeof index.truncated === "object" ? index.truncated : null
  };
}

/** OpenClaw can load the plugin straight from a directory (plugins.load.paths) instead of an extension copy. */
function openClawLoadPath(config) {
  for (const dir of config?.plugins?.load?.paths ?? []) {
    const pkg = readJson(path.join(dir, "package.json"));
    const manifest = readJson(path.join(dir, "openclaw.plugin.json"));
    if (pkg?.name === PLUGIN_ID || manifest?.id === PLUGIN_ID) return { installed: true, dir, linkedTo: null, loadPath: true, version: pkg?.version ?? null };
  }
  return null;
}

function installInfo(dir, versionOf) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { return { installed: false, dir }; }
  const linkedTo = stat.isSymbolicLink() ? fs.readlinkSync(dir) : null;
  return { installed: true, dir, linkedTo, version: versionOf(dir) };
}
const versionFromJson = (file) => (dir) => readJson(path.join(dir, file))?.version ?? null;
const versionFromYaml = (dir) => /^version:\s*(\S+)\s*$/mu.exec(readText(path.join(dir, "plugin.yaml")) ?? "")?.[1] ?? null;

/** Best-effort read of `plugins.entries.<id>.settings.vault_path` and `plugins.enabled` from Hermes' config.yaml. */
export function hermesSettings(yamlText) {
  const out = { enabled: false, vaultPath: null };
  if (typeof yamlText !== "string") return out;
  const lines = yamlText.split(/\r?\n/u);
  let inEnabled = false, entryIndent = -1;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^enabled:\s*$/u.test(trimmed)) { inEnabled = true; continue; }
    if (inEnabled) {
      if (trimmed.startsWith("- ")) { if (trimmed.slice(2).trim() === PLUGIN_ID) out.enabled = true; continue; }
      if (trimmed) inEnabled = false;
    }
    if (trimmed === `${PLUGIN_ID}:`) { entryIndent = indent; continue; }
    if (entryIndent >= 0) {
      if (trimmed && indent <= entryIndent) { entryIndent = -1; continue; }
      const m = /^vault_path:\s*(.+)$/u.exec(trimmed);
      if (m) out.vaultPath = m[1].trim().replace(/^(['"])(.*)\1$/u, "$2") || null;
    }
  }
  return out;
}

/** Collect the report. `home`/`env` are injectable for tests. */
export function collect({ home = os.homedir(), env = process.env, packageVersion = null } = {}) {
  const hosts = [];
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");

  // OpenClaw: plugins.entries.<id>.config.{vaultPath, agentConfigs.*.vaultPath}
  const ocConfigPath = env.OPENCLAW_CONFIG_PATH?.trim() || path.join(home, ".openclaw", "openclaw.json");
  const ocConfig = readJson(ocConfigPath);
  const ocEntry = ocConfig?.plugins?.entries?.[PLUGIN_ID] ?? null;
  const ocVaults = [];
  if (ocEntry?.config?.vaultPath) ocVaults.push({ where: `${ocConfigPath} (config.vaultPath)`, path: ocEntry.config.vaultPath });
  for (const [agent, cfg] of Object.entries(ocEntry?.config?.agentConfigs ?? {})) {
    if (cfg?.vaultPath) ocVaults.push({ where: `${ocConfigPath} (agent "${agent}")`, path: cfg.vaultPath });
  }
  hosts.push({ host: "OpenClaw", enabled: ocEntry ? ocEntry.enabled !== false : false, vaults: ocVaults,
    install: openClawLoadPath(ocConfig) ?? installInfo(path.join(home, ".openclaw", "extensions", PLUGIN_ID), versionFromJson("package.json")) });

  // Codex: managed block in AGENTS.override.md (when non-empty) or AGENTS.md; marketplace install in the plugin cache.
  const override = path.join(codexHome, "AGENTS.override.md");
  const rules = (readText(override) ?? "").trim() ? override : path.join(codexHome, "AGENTS.md");
  const codexVault = vaultPathFromRuleText(readText(rules));
  const cacheRoot = path.join(codexHome, "plugins", "cache", "obsidian-memory", "obsidian-memory");
  let codexVersions = [];
  try { codexVersions = fs.readdirSync(cacheRoot).filter((v) => /^\d+\.\d+\.\d+/u.test(v)).sort(); } catch {}
  const codexToml = readText(path.join(codexHome, "config.toml")) ?? "";
  const codexEnabled = /\[plugins\."obsidian-memory@obsidian-memory"\][^[]*enabled\s*=\s*true/u.test(codexToml);
  const userHooks = readText(path.join(codexHome, "hooks.json")) ?? "";
  hosts.push({ host: "Codex", enabled: codexEnabled, vaults: codexVault ? [{ where: rules, path: codexVault }] : [],
    install: codexVersions.length
      ? { installed: true, dir: path.join(cacheRoot, codexVersions.at(-1)), linkedTo: null, version: codexVersions.at(-1) }
      : { installed: false, dir: cacheRoot },
    // The plugin's hooks (hooks/hooks.json) run once approved on the plugin page / via /hooks; Codex records
    // [hooks.state."obsidian-memory@obsidian-memory:hooks/hooks.json:<event>:i:j"]. A user-level copy in
    // ~/.codex/hooks.json ("setup-codex --hooks") is the fallback, recorded under the hooks.json path.
    hooks: ["UserPromptSubmit", "Stop"].map((event) => {
      const script = event === "Stop" ? "codex-stop-hook.mjs" : "codex-hook.mjs";
      const snake = event === "Stop" ? "stop" : "user_prompt_submit";
      const trustedUnder = (prefix) => codexToml.split("[hooks.state.").some((block) => block.startsWith(`"${prefix}:${snake}:`) && /trusted_hash\s*=/u.test(block));
      const installed = codexVersions.length ? readText(path.join(cacheRoot, codexVersions.at(-1), "hooks", "hooks.json")) ?? "" : "";
      const inPlugin = installed.includes(`"${event}"`) && installed.includes(script);
      const inUser = new RegExp(`"${event}"[\\s\\S]*?${script.replace(".", "\\.")}`, "u").test(userHooks);
      return {
        event, inPlugin, inUser,
        trusted: (inPlugin && trustedUnder("obsidian-memory@obsidian-memory:hooks/hooks.json")) || (inUser && trustedUnder(path.join(codexHome, "hooks.json")))
      };
    }) });

  // Antigravity: managed block in ~/.gemini/GEMINI.md; plugin in ~/.gemini/config/plugins/<id>.
  const gemini = path.join(home, ".gemini", "GEMINI.md");
  const agVault = vaultPathFromRuleText(readText(gemini));
  hosts.push({ host: "Antigravity", enabled: Boolean(agVault), vaults: agVault ? [{ where: gemini, path: agVault }] : [],
    install: installInfo(path.join(home, ".gemini", "config", "plugins", PLUGIN_ID), versionFromJson("plugin.json")) });

  // Hermes: settings.vault_path in config.yaml; plugin in ~/.hermes/plugins/<id>.
  const hermesHome = env.HERMES_HOME?.trim() || path.join(home, ".hermes");
  const hs = hermesSettings(readText(path.join(hermesHome, "config.yaml")));
  hosts.push({ host: "Hermes", enabled: hs.enabled, vaults: hs.vaultPath ? [{ where: path.join(hermesHome, "config.yaml"), path: hs.vaultPath }] : [],
    install: installInfo(path.join(hermesHome, "plugins", PLUGIN_ID), versionFromYaml) });

  const envVault = env.OBSIDIAN_MEMORY_VAULT?.trim() || null;

  // Laya
  const layaDir = layaHome({ env, homedir: () => home });
  const service = readJson(path.join(layaDir, "service.json"));
  let cli = null;
  try { cli = fs.readlinkSync(path.join(home, ".local", "bin", "laya")); } catch {}
  const laya = {
    service: service ? { endpoint: service.endpoint ?? null, pid: service.pid ?? null } : null,
    userHead: fs.existsSync(path.join(layaDir, "recall-head.json")) ? path.join(layaDir, "recall-head.json") : null,
    labels: (() => { try { return fs.readdirSync(layaDir).filter((f) => /^labels.*\.jsonl$/u.test(f)); } catch { return []; } })(),
    cli
  };
  const digest = digestStatus(layaDir);
  // Which model the digest extracts with (see scripts/memory-digest.mjs): none means the keyword selection.
  const wanted = env.OBSIDIAN_MEMORY_DIGEST_EXTRACTOR?.trim().toLowerCase() || "auto";
  const extractor = resolveExtractor({ preference: EXTRACTORS.includes(wanted) ? wanted : "auto", env: { ...env, HOME: home }, codexHome: env.CODEX_HOME || path.join(home, ".codex") });
  digest.extractor = extractor ? (extractor.model ? `${extractor.name}/${extractor.model}` : extractor.name) : null;
  digest.extractorSetting = wanted;

  // Findings
  const issues = [];
  const allVaults = [...hosts.flatMap((h) => h.vaults.map((v) => ({ ...v, host: h.host }))), ...(envVault ? [{ host: "env", where: "OBSIDIAN_MEMORY_VAULT", path: envVault }] : [])];
  const distinct = [...new Set(allVaults.map((v) => physical(v.path)))];
  if (distinct.length > 1) issues.push(`Vault paths disagree: ${distinct.join(" | ")}`);
  for (const v of allVaults) if (!fs.existsSync(v.path)) issues.push(`${v.host}: Vault path does not exist: ${v.path}`);
  for (const h of hosts) {
    if (h.install.installed && h.install.linkedTo) issues.push(`${h.host}: plugin is a symlink to ${h.install.linkedTo} (tracks a checkout, not a release)`);
    if (packageVersion && h.install.installed && h.install.version && h.install.version !== packageVersion) {
      issues.push(`${h.host}: installed ${h.install.version}, this package is ${packageVersion}`);
    }
    if (h.enabled && h.vaults.length === 0 && !envVault) issues.push(`${h.host}: enabled but no Vault path configured`);
    if (h.host === "Codex" && h.enabled && h.hooks) {
      const missing = h.hooks.filter((x) => !x.inPlugin && !x.inUser).map((x) => x.event);
      const pending = h.hooks.filter((x) => (x.inPlugin || x.inUser) && !x.trusted).map((x) => x.event);
      const twice = h.hooks.filter((x) => x.inPlugin && x.inUser).map((x) => x.event);
      if (missing.length) issues.push(`Codex: ${missing.join(" and ")} hook missing from the installed plugin; update the plugin (codex plugin marketplace upgrade)`);
      if (pending.length) issues.push(`Codex: ${pending.join(" and ")} hook not approved yet; in the Codex app open Plugins > Obsidian Memory and choose "Trust all" under Hooks (or /hooks in the Codex CLI). Until then ${pending.includes("UserPromptSubmit") ? "Codex gets no memory hints" : ""}${pending.length > 1 ? " and " : ""}${pending.includes("Stop") ? "nothing is captured at the end of a Codex turn" : ""}`);
      if (twice.length) issues.push(`Codex: ${twice.join(" and ")} hook registered both by the plugin and in ~/.codex/hooks.json (runs twice); remove the obsidian-memory entries from ~/.codex/hooks.json`);
    }
  }
  if (digest.queuedSessions && digest.oldestQueuedMs > DAY_MS && !digest.waiterAlive) {
    issues.push(`Session digest: ${digest.queuedSessions} queued session(s), oldest ${Math.round(digest.oldestQueuedMs / 3600000)} h, and no digest is waiting; run 'laya digest' to process them`);
  }
  if (digest.errors7d) issues.push(`Session digest: ${digest.errors7d} run(s) in the last 7 days could not finish (see ${path.join(layaDir, "digest-log.jsonl")})`);
  if (!digest.extractor && wanted !== "off" && hosts.some((h) => h.enabled || h.install.installed)) issues.push("Session digest: no Codex (logged in) or Hermes CLI found for model extraction, so automatic capture falls back to keyword selection (mostly status reports); install or log in to one, or set OBSIDIAN_MEMORY_DIGEST_EXTRACTOR=off to accept that");
  if (digest.extractFailures7d) issues.push(`Session digest: model extraction failed ${digest.extractFailures7d} time(s) in the last 7 days (queues are kept and retried); last error: ${digest.lastExtractError}`);
  if (digest.held) issues.push(`Session digest: ${digest.held} finding(s) held because their session had no project; list them with 'laya digest --held', then file or discard each`);
  if (digest.oversizedQueues) issues.push(`Session digest: ${digest.oversizedQueues} session queue(s) reached 2 MB and stopped taking turns; run 'laya digest --now'`);
  if (digest.indexTruncated) issues.push(`Vault index: over 2000 notes, so some were left out of Vault hints (${Object.entries(digest.indexTruncated).map(([id, n]) => `${id} ${n}`).join(", ")}); newest notes of every project are kept`);
  if (laya.cli && !fs.existsSync(path.resolve(path.join(home, ".local", "bin"), laya.cli))) issues.push(`laya CLI points to a missing file: ${laya.cli}`);
  return { packageVersion, envVault, hosts, laya, digest, issues };
}

function render(report, stdout) {
  const w = (s = "") => stdout.write(s + "\n");
  w(`Obsidian Memory doctor (this package: ${report.packageVersion ?? "?"})`);
  w(`OBSIDIAN_MEMORY_VAULT: ${report.envVault ?? "(not set)"}`);
  for (const h of report.hosts) {
    const inst = h.install.installed
      ? `${h.install.version ?? "?"}${h.install.linkedTo ? ` (symlink -> ${h.install.linkedTo})` : ""}${h.install.loadPath ? ` (loaded from ${h.install.dir})` : ""}`
      : "not installed";
    w(`\n${h.host}: plugin ${inst}${h.enabled ? ", enabled" : ""}`);
    if (h.vaults.length === 0) w("  Vault: (none)");
    for (const v of h.vaults) w(`  Vault: ${v.path}\n    from ${v.where}`);
  }
  const l = report.laya;
  w(`\nLaya: service ${l.service ? `registered at ${l.service.endpoint} (pid ${l.service.pid})` : "not running"}; ` +
    `recall head ${l.userHead ?? "bundled / zero-shot"}; labels ${l.labels.length ? l.labels.join(", ") : "none"}; CLI -> ${l.cli ?? "(not linked)"}`);
  const d = report.digest;
  w(`Session digest: ${d.queuedSessions} queued session(s)${d.waiterAlive ? ", waiting to digest" : ""}; last run ${d.lastRun ?? "never"}; ` +
    `${d.written7d} candidate(s) staged in the last 7 days${d.held ? `; ${d.held} held (no project)` : ""}; ` +
    `extraction: ${d.extractor ?? (d.extractorSetting === "off" ? "off (keyword selection)" : "none found (keyword selection)")}`);
  if (d.backfillPausedUntil) w(`Vault embeddings: backfill paused until ${d.backfillPausedUntil} after a slow or failed retriever call`);
  w(report.issues.length ? `\n${report.issues.length} issue(s):` : "\nNo issues found.");
  for (const i of report.issues) w(`  - ${i}`);
}

const isMain = process.argv[1] && (() => { try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const pkg = readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
  const report = collect({ packageVersion: pkg?.version ?? null });
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else render(report, process.stdout);
}
