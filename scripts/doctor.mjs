#!/usr/bin/env node
/**
 * One read-only look at every place this plugin is installed and configured.
 *
 *   npm run doctor            # human-readable report
 *   npm run doctor -- --json  # machine-readable
 *
 * The Vault path is configured per host (each host has its own config format), so it lives in
 * several places. This lists them side by side and flags a disagreement, an outdated plugin copy,
 * a copy linked to a development checkout, a doubly registered Codex hook, and the Laya service
 * state. Nothing is written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vaultPathFromRuleText } from "../lib/memory-router/vault-index.js";

const PLUGIN_ID = "obsidian-memory-plugin";

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const physical = (p) => { try { return realpathSync(p); } catch { return p; } };

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
  const ocEntry = readJson(ocConfigPath)?.plugins?.entries?.[PLUGIN_ID] ?? null;
  const ocVaults = [];
  if (ocEntry?.config?.vaultPath) ocVaults.push({ where: `${ocConfigPath} (config.vaultPath)`, path: ocEntry.config.vaultPath });
  for (const [agent, cfg] of Object.entries(ocEntry?.config?.agentConfigs ?? {})) {
    if (cfg?.vaultPath) ocVaults.push({ where: `${ocConfigPath} (agent "${agent}")`, path: cfg.vaultPath });
  }
  hosts.push({ host: "OpenClaw", enabled: ocEntry ? ocEntry.enabled !== false : false, vaults: ocVaults,
    install: installInfo(path.join(home, ".openclaw", "extensions", PLUGIN_ID), versionFromJson("package.json")) });

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
    duplicateHook: codexEnabled && /codex-hook\.mjs/u.test(userHooks) });

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
  const layaDir = path.join(env.LAYA_HOME?.trim() || home, ".laya");
  const service = readJson(path.join(layaDir, "service.json"));
  let cli = null;
  try { cli = fs.readlinkSync(path.join(home, ".local", "bin", "laya")); } catch {}
  const laya = {
    service: service ? { endpoint: service.endpoint ?? null, pid: service.pid ?? null } : null,
    userHead: fs.existsSync(path.join(layaDir, "recall-head.json")) ? path.join(layaDir, "recall-head.json") : null,
    labels: (() => { try { return fs.readdirSync(layaDir).filter((f) => /^labels.*\.jsonl$/u.test(f)); } catch { return []; } })(),
    cli
  };

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
    if (h.duplicateHook) issues.push("Codex: codex-hook.mjs is registered both by the plugin and in ~/.codex/hooks.json (runs twice)");
  }
  if (laya.cli && !fs.existsSync(path.resolve(path.join(home, ".local", "bin"), laya.cli))) issues.push(`laya CLI points to a missing file: ${laya.cli}`);
  return { packageVersion, envVault, hosts, laya, issues };
}

function render(report, stdout) {
  const w = (s = "") => stdout.write(s + "\n");
  w(`Obsidian Memory doctor (this package: ${report.packageVersion ?? "?"})`);
  w(`OBSIDIAN_MEMORY_VAULT: ${report.envVault ?? "(not set)"}`);
  for (const h of report.hosts) {
    const inst = h.install.installed
      ? `${h.install.version ?? "?"}${h.install.linkedTo ? ` (symlink -> ${h.install.linkedTo})` : ""}`
      : "not installed";
    w(`\n${h.host}: plugin ${inst}${h.enabled ? ", enabled" : ""}`);
    if (h.vaults.length === 0) w("  Vault: (none)");
    for (const v of h.vaults) w(`  Vault: ${v.path}\n    from ${v.where}`);
  }
  const l = report.laya;
  w(`\nLaya: service ${l.service ? `registered at ${l.service.endpoint} (pid ${l.service.pid})` : "not running"}; ` +
    `recall head ${l.userHead ?? "bundled / zero-shot"}; labels ${l.labels.length ? l.labels.join(", ") : "none"}; CLI -> ${l.cli ?? "(not linked)"}`);
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
