import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "../lib/memory-router/router.js";

const root = fileURLToPath(new URL("../", import.meta.url));

function files(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir);
  return out.sort();
}

test("mode off: the router writes nothing (no session state, Vault index, decision log or capture queue)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-off-"));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "om-off-vault-"));
  fs.mkdirSync(path.join(vault, "20-Projects"), { recursive: true });
  const router = new MemoryRouter({ mode: "off", serviceFile: path.join(dir, "service.json") }, {
    env: {}, sessionStatePath: path.join(dir, "s.json"), vaultIndexCachePath: path.join(dir, "vi.json"), decisionLogPath: path.join(dir, "d.jsonl")
  });
  const d = await router.evaluateRecall("安装脚本遇到失效的软链接会报 EEXIST", null, { host: "codex", sessionKey: "s", vaultPath: vault, cwd: root });
  router.dispose();
  assert.equal(d.reason, "mode_off");
  assert.deepEqual(files(dir), []);
});

test("mode off: the Codex and Antigravity hooks leave no file anywhere, like before the router existed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "om-off-hooks-"));
  const laya = path.join(tmp, "laya");
  const svc = path.join(tmp, "svc");
  fs.mkdirSync(laya); fs.mkdirSync(svc);
  const env = {
    ...process.env,
    OBSIDIAN_MEMORY_LAYA_DIR: laya,
    OBSIDIAN_MEMORY_SERVICE_FILE: path.join(svc, "service.json"),
    OBSIDIAN_MEMORY_JUDGE_MODE: "off",
    OBSIDIAN_MEMORY_DECISION_LOG: "on",
    OBSIDIAN_MEMORY_DIGEST: "on"
  };
  const reply = "已修复。根因是 existsSync 会跟随软链接，失效时返回 false。修法：直接 rmSync force。以后统一先 lstat。".repeat(6);
  const run = (script, payload) => spawnSync(process.execPath, [path.join(root, "scripts", script)], { input: JSON.stringify(payload), env, encoding: "utf8", cwd: root });
  const a = run("codex-hook.mjs", { session_id: "off-1", cwd: root, prompt: "安装脚本遇到失效的软链接会报 EEXIST，该怎么改" });
  const b = run("codex-stop-hook.mjs", { session_id: "off-1", last_assistant_message: reply });
  const c = run("antigravity-hook.mjs", { conversationId: "off-agy", prompt: "安装脚本遇到失效的软链接", cwd: root });
  for (const r of [a, b, c]) assert.equal(r.status, 0, r.stderr);
  assert.equal(b.stdout.trim(), "", "the Stop hook never blocks in mode off");
  assert.equal(c.stdout.trim(), "{}");
  assert.deepEqual(files(tmp), [], "nothing under the Laya folder or next to the service file");
});
