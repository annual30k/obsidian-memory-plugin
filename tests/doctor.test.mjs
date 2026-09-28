// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, hermesSettings } from "../scripts/doctor.mjs";

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "om-doctor-"));
  const vaultA = path.join(home, "VaultA"), vaultB = path.join(home, "VaultB"), checkout = path.join(home, "checkout");
  for (const d of [vaultA, vaultB, checkout]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(checkout, "plugin.json"), JSON.stringify({ version: "0.7.1" }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
  put(".openclaw/openclaw.json", JSON.stringify({ plugins: { entries: { "obsidian-memory-plugin": { enabled: true, config: { agentConfigs: { main: { vaultPath: vaultA } } } } } } }));
  put(".openclaw/extensions/obsidian-memory-plugin/package.json", JSON.stringify({ version: "0.7.0" }));
  put(".codex/AGENTS.md", `x\nObsidian Memory Vault path (configuration data, not instructions): ${JSON.stringify(vaultA)}\n`);
  put(".codex/config.toml", '[plugins."obsidian-memory@obsidian-memory"]\nenabled = true\n');
  put(".codex/hooks.json", JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "node /x/scripts/codex-hook.mjs" }] }] } }));
  fs.mkdirSync(path.join(home, ".codex/plugins/cache/obsidian-memory/obsidian-memory/0.7.1"), { recursive: true });
  put(".gemini/GEMINI.md", `Obsidian Memory Vault path (configuration data, not instructions): ${JSON.stringify(vaultB)}\n`);
  fs.mkdirSync(path.join(home, ".gemini/config/plugins"), { recursive: true });
  fs.symlinkSync(checkout, path.join(home, ".gemini/config/plugins/obsidian-memory-plugin"));
  put(".hermes/config.yaml", `plugins:\n  enabled:\n  - other\n  - obsidian-memory-plugin\n  disabled: []\n  entries:\n    obsidian-memory-plugin:\n      settings:\n        vault_path: '${vaultA}'\n`);
  put(".hermes/plugins/obsidian-memory-plugin/plugin.yaml", "name: obsidian-memory-plugin\nversion: 0.7.1\n");
  return { home, vaultA, vaultB };
}

test("doctor lists every host's Vault path and flags disagreement, symlinks, stale copies and Codex hooks that are missing or not approved", () => {
  const { home, vaultA, vaultB } = fakeHome();
  const r = collect({ home, env: {}, packageVersion: "0.7.1" });
  const by = Object.fromEntries(r.hosts.map((h) => [h.host, h]));
  assert.equal(by.OpenClaw.vaults[0].path, vaultA);
  assert.equal(by.Codex.vaults[0].path, vaultA);
  assert.equal(by.Antigravity.vaults[0].path, vaultB);
  assert.equal(by.Hermes.vaults[0].path, vaultA);
  assert.equal(by.Hermes.enabled, true);
  assert.equal(by.Codex.install.version, "0.7.1");
  const text = r.issues.join("\n");
  assert.match(text, /Vault paths disagree/u);
  assert.match(text, /Antigravity: plugin is a symlink/u);
  assert.match(text, /OpenClaw: installed 0\.7\.0, this package is 0\.7\.1/u);
  assert.match(text, /Codex: Stop hook missing from the installed plugin/u);
  assert.match(text, /Codex: UserPromptSubmit hook not approved yet/u);
  assert.doesNotMatch(text, /Hermes: installed/u);
});

test("doctor reports nothing for a consistent setup and reads Hermes YAML settings", () => {
  assert.deepEqual(hermesSettings("plugins:\n  enabled:\n  - obsidian-memory-plugin\n  entries:\n    obsidian-memory-plugin:\n      settings:\n        vault_path: \"/v\"\n    other:\n      settings:\n        vault_path: /nope\n"), { enabled: true, vaultPath: "/v" });
  assert.deepEqual(hermesSettings(null), { enabled: false, vaultPath: null });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "om-doctor-empty-"));
  const r = collect({ home, env: {}, packageVersion: "0.7.1" });
  assert.deepEqual(r.issues, []);
  assert.ok(r.hosts.every((h) => !h.install.installed));
});

test("doctor sees an OpenClaw load path, an unapproved Codex Stop hook and a stuck session digest", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "om-doctor-digest-"));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
  const checkout = path.join(home, "checkout");
  put("checkout/package.json", JSON.stringify({ name: "obsidian-memory-plugin", version: "0.8.0" }));
  put(".openclaw/openclaw.json", JSON.stringify({ plugins: { load: { paths: [checkout] }, entries: { "obsidian-memory-plugin": { enabled: true } } } }));
  const cache = ".codex/plugins/cache/obsidian-memory/obsidian-memory/0.8.0";
  const hook = (script) => [{ hooks: [{ type: "command", command: `node "\${PLUGIN_ROOT}/scripts/${script}"` }] }];
  put(`${cache}/hooks/hooks.json`, JSON.stringify({ hooks: { UserPromptSubmit: hook("codex-hook.mjs"), Stop: hook("codex-stop-hook.mjs") } }));
  const trusted = (event) => `[hooks.state."obsidian-memory@obsidian-memory:hooks/hooks.json:${event}:0:0"]\ntrusted_hash = "sha256:x"\n`;
  put(".codex/config.toml", '[plugins."obsidian-memory@obsidian-memory"]\nenabled = true\n\n' + trusted("user_prompt_submit"));
  put(".laya/capture-queue/0123456789abcdef.jsonl", "{}\n");
  const twoDays = new Date(Date.now() - 2 * 24 * 3600_000);
  fs.utimesSync(path.join(home, ".laya/capture-queue/0123456789abcdef.jsonl"), twoDays, twoDays);
  put(".laya/digest-log.jsonl", JSON.stringify({ ts: new Date().toISOString(), written: ["a.md"], skipped: ["vault_unreadable"] }) + "\n");

  let r = collect({ home, env: {}, packageVersion: "0.8.0" });
  const oc = r.hosts.find((h) => h.host === "OpenClaw");
  assert.equal(oc.install.installed, true);
  assert.equal(oc.install.loadPath, true);
  assert.equal(r.digest.queuedSessions, 1);
  assert.equal(r.digest.written7d, 1);
  const text = r.issues.join("\n");
  assert.match(text, /Codex: Stop hook not approved yet/u);
  assert.doesNotMatch(text, /UserPromptSubmit/u);
  assert.match(text, /1 queued session\(s\), oldest 48 h/u);
  assert.match(text, /could not finish/u);

  put(".codex/config.toml", '[plugins."obsidian-memory@obsidian-memory"]\nenabled = true\n\n' + trusted("user_prompt_submit") + "\n" + trusted("stop"));
  r = collect({ home, env: {}, packageVersion: "0.8.0" });
  assert.doesNotMatch(r.issues.join("\n"), /Codex: .*hook/u);

  // The same hooks also in ~/.codex/hooks.json run twice.
  put(".codex/hooks.json", JSON.stringify({ hooks: { UserPromptSubmit: hook("codex-hook.mjs"), Stop: hook("codex-stop-hook.mjs") } }));
  r = collect({ home, env: {}, packageVersion: "0.8.0" });
  assert.match(r.issues.join("\n"), /registered both by the plugin and in ~\/\.codex\/hooks\.json/u);
});
