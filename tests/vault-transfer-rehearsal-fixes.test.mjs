// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExport } from "../lib/vault-transfer/export.js";
import { applyImport, looseText, planImport } from "../lib/vault-transfer/import.js";

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = (f) => fs.readFileSync(f, "utf8");

function makeVault(root) {
  write(path.join(root, "00-System", "projects.yaml"), "projects:\n  - id: app-1\n    roots: []\n    scope: private\n");
  write(path.join(root, "AGENTS.md"), "# Vault Root\n");
  write(path.join(root, "Home.md"), "# Home\n");
  write(path.join(root, "10-Global", "index.md"), "# Global Index\n");
  write(path.join(root, "10-Global", "log.md"), "# Global Log\n");
  write(path.join(root, "20-Projects", "app-1", "index.md"), "# app-1 Index\n");
  write(path.join(root, "20-Projects", "app-1", "log.md"), "# Log\n");
  write(path.join(root, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: note\n---\n\nbody\n");
  return root;
}

test("exitAfterFlush keeps large output intact on a pipe and keeps the exit code", () => {
  const dir = tmp("om-exit-");
  const script = path.join(dir, "big.mjs");
  const lib = new URL("../lib/exit-after-flush.js", import.meta.url).href;
  fs.writeFileSync(script, `import { exitAfterFlush } from ${JSON.stringify(lib)};\nprocess.stdout.write("x".repeat(300000));\nexitAfterFlush(3);\n`);
  const r = spawnSync(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.length, 300000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("re-importing a bundle does not park the same conflict again until it is merged", () => {
  const base = tmp("om-reparked-");
  const A = makeVault(path.join(base, "A"));
  const B = makeVault(path.join(base, "B"));
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: note\n---\n\nbody from A\n");
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: note\n---\n\nbody from B\n");
  const bundle = buildExport(A, { layaDir: path.join(base, "lA") }).bundle;
  const opts = { targetVault: B, layaDir: path.join(base, "lB"), includeLaya: false };

  const first = planImport(bundle, { ...opts, now: new Date(2026, 10, 28, 10, 0, 0) });
  assert.equal(first.vault.conflicts.length, 1);
  applyImport(first, { backup: false });
  const firstCopy = first.vault.conflicts[0].copy;
  assert.ok(fs.existsSync(path.join(B, ...firstCopy.split("/"))));

  const again = planImport(bundle, { ...opts, now: new Date(2026, 10, 28, 11, 0, 0) });
  assert.deepEqual(again.vault.conflicts, []);
  assert.deepEqual(again.vault.alreadyParked, [{ rel: "20-Projects/app-1/wiki/knowledge/note.md", copy: firstCopy }]);
  assert.equal(again.writes.filter((w) => w.abs.includes("import-conflicts")).length, 0, "no new copy, no new README");

  // Once merged (the parked folder deleted), a still-different incoming note is parked again.
  fs.rmSync(path.join(B, "00-System", "import-conflicts"), { recursive: true, force: true });
  const afterMerge = planImport(bundle, { ...opts, now: new Date(2026, 10, 28, 12, 0, 0) });
  assert.equal(afterMerge.vault.conflicts.length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test("notes that differ only in trailing whitespace or blank lines are not conflicts", () => {
  assert.equal(looseText("a  \r\n\r\nb\t\n\n\n"), looseText("a\n\nb\n"));
  assert.notEqual(looseText("a b\n"), looseText("ab\n"));
  assert.notEqual(looseText("  indented\n"), looseText("indented\n"), "leading whitespace still counts");

  const base = tmp("om-ws-");
  const A = makeVault(path.join(base, "A"));
  const B = makeVault(path.join(base, "B"));
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: note\n---\n\nbody\n");
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: note\n---\n \nbody  \n\n");
  const plan = planImport(buildExport(A, { layaDir: path.join(base, "lA") }).bundle, { targetVault: B, layaDir: path.join(base, "lB"), includeLaya: false });
  assert.deepEqual(plan.vault.conflicts, []);
  assert.deepEqual(plan.vault.whitespaceOnly, ["20-Projects/app-1/wiki/knowledge/note.md"]);
  applyImport(plan, { backup: false });
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), "---\ntitle: note\n---\n \nbody  \n\n", "local kept as it is");
  assert.ok(!fs.existsSync(path.join(B, "00-System", "import-conflicts")));
  fs.rmSync(base, { recursive: true, force: true });
});
