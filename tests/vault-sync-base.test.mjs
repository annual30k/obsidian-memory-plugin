// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExport } from "../lib/vault-transfer/export.js";
import { applyImport, openBundle, planImport } from "../lib/vault-transfer/import.js";
import { ancestorsFromEntries, readSynced, syncHash, syncStatePath } from "../lib/vault-transfer/sync-base.js";
import { main as importMain } from "../scripts/import-vault.mjs";

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = (f) => fs.readFileSync(f, "utf8");
const sink = () => { let s = ""; return { write: (x) => { s += x; }, get text() { return s; } }; };

function seed(root) {
  write(path.join(root, "00-System", "projects.yaml"), "projects: []\n");
  write(path.join(root, "AGENTS.md"), "# Vault\n");
  write(path.join(root, "Home.md"), "# Home\n");
  write(path.join(root, "10-Global", "preferences.md"), "- a\n");
  write(path.join(root, "10-Global", "index.md"), "# Index\n");
  write(path.join(root, "10-Global", "wiki", "knowledge", "x.md"), "x v1\n");
  write(path.join(root, "10-Global", "wiki", "knowledge", "gone.md"), "will be deleted\n");
  return root;
}

test("three-way import: a file only one side changed since the last agreement is not a conflict", () => {
  const base = tmp("om-sync-");
  const mac = seed(path.join(base, "mac"));
  const layaMac = path.join(base, "laya-mac");
  const layaWin = path.join(base, "laya-win");
  const e1 = buildExport(mac, { layaDir: layaMac }).bundle;
  const win = path.join(base, "win");
  applyImport(planImport(e1, { targetVault: win, layaDir: layaWin, includeLaya: false }));
  assert.ok(Object.keys(readSynced(win, { layaDir: layaWin })).includes("Home.md"), "the import recorded what both now agree on");

  // Windows: edits Home and x, CRLF-only rewrite of preferences. Mac: edits AGENTS, deletes gone.md.
  write(path.join(win, "Home.md"), "# Home\n\n- from Windows\n");
  write(path.join(win, "10-Global", "wiki", "knowledge", "x.md"), "x v2 (Windows)\n");
  write(path.join(win, "10-Global", "preferences.md"), "- a\r\n");
  write(path.join(mac, "AGENTS.md"), "# Vault\n\nEdited on the Mac.\n");
  fs.rmSync(path.join(mac, "10-Global", "wiki", "knowledge", "gone.md"));
  const e2 = buildExport(win, { layaDir: layaWin }).bundle;
  assert.ok(Object.keys(JSON.parse(openBundle(e2).manifest ? JSON.stringify(openBundle(e2).manifest.synced) : "{}")).includes("vault/Home.md"), "the export carries its record");

  const plan = planImport(e2, { targetVault: mac, layaDir: layaMac, includeLaya: false });
  assert.deepEqual(plan.vault.conflicts, []);
  assert.deepEqual(plan.vault.fastForward.sort(), ["10-Global/wiki/knowledge/x.md", "Home.md"]);
  assert.deepEqual(plan.vault.keptNewer, ["AGENTS.md"]);
  assert.deepEqual(plan.vault.deletedHere, ["10-Global/wiki/knowledge/gone.md"], "a deletion here is not undone");
  assert.ok(plan.vault.same.includes("10-Global/preferences.md"), "CRLF is the same version");
  applyImport(plan);
  assert.equal(read(path.join(mac, "Home.md")), "# Home\n\n- from Windows\n");
  assert.equal(read(path.join(mac, "AGENTS.md")), "# Vault\n\nEdited on the Mac.\n");
  assert.ok(!fs.existsSync(path.join(mac, "10-Global", "wiki", "knowledge", "gone.md")));
  assert.equal(planImport(e2, { targetVault: mac, layaDir: layaMac, includeLaya: false }).writes.length, 0, "re-import is a no-op");

  // The Mac's export now carries the agreement, so Windows takes the Mac-only change too.
  const back = planImport(buildExport(mac, { layaDir: layaMac }).bundle, { targetVault: win, layaDir: layaWin, includeLaya: false });
  assert.deepEqual(back.vault.conflicts, []);
  assert.deepEqual(back.vault.fastForward, ["AGENTS.md"]);
  applyImport(back);
  assert.equal(read(path.join(win, "AGENTS.md")), read(path.join(mac, "AGENTS.md")));

  // Both sides changing the same file is still a conflict.
  write(path.join(mac, "Home.md"), "# Home\n\n- Mac again\n");
  write(path.join(win, "Home.md"), "# Home\n\n- Windows again\n");
  const both = planImport(buildExport(win, { layaDir: layaWin }).bundle, { targetVault: mac, layaDir: layaMac, includeLaya: false });
  assert.deepEqual(both.vault.conflicts.map((c) => c.rel), ["Home.md"]);
  fs.rmSync(base, { recursive: true, force: true });
});

test("--base: Vaults synced before the records existed use an older bundle as the common ancestor", async () => {
  const base = tmp("om-sync-base-");
  const mac = seed(path.join(base, "mac"));
  const e1 = buildExport(mac, { layaDir: path.join(base, "l0") }).bundle;
  const e1file = path.join(base, "e1.tar.gz");
  fs.writeFileSync(e1file, e1);
  const win = path.join(base, "win");
  const layaWin = path.join(base, "laya-win");
  applyImport(planImport(e1, { targetVault: win, layaDir: layaWin, includeLaya: false }));
  fs.rmSync(syncStatePath(win, { layaDir: layaWin }));   // as an import made before 0.13.1
  write(path.join(win, "Home.md"), "# Home\n\n- from Windows\n");
  write(path.join(mac, "AGENTS.md"), "# Vault\n\nEdited on the Mac.\n");
  const e2file = path.join(base, "e2.tar.gz");
  fs.writeFileSync(e2file, buildExport(win, { layaDir: layaWin }).bundle);
  const layaMac = path.join(base, "laya-mac");

  const plain = planImport(fs.readFileSync(e2file), { targetVault: mac, layaDir: layaMac, includeLaya: false });
  assert.deepEqual(plain.vault.conflicts.map((c) => c.rel).sort(), ["AGENTS.md", "Home.md"], "without an ancestor both look like conflicts");

  assert.deepEqual(ancestorsFromEntries(openBundle(e1).entries)["Home.md"], syncHash("Home.md", "# Home\n"));
  const out = sink();
  assert.equal(await importMain([e2file, "--vault", mac, "--base", e1file], out, sink(), { layaDir: layaMac }), 0);
  assert.match(out.text, /Changed on one side only since the last sync \(ancestors from the --base bundle\)/u);
  assert.match(out.text, /1 file\(s\) changed only on the other machine: would be updated here\n\s+Home\.md/u);
  assert.match(out.text, /1 file\(s\) changed only here: kept/u);
  assert.match(out.text, /0 conflict\(s\)/u);
  assert.equal(await importMain([e2file, "--vault", mac, "--base", e1file, "--yes"], sink(), sink(), { layaDir: layaMac, collectHosts: () => ({ hosts: [] }) }), 0);
  assert.equal(read(path.join(mac, "Home.md")), "# Home\n\n- from Windows\n");
  assert.equal(syncHash("Home.md", read(path.join(mac, "Home.md"))), readSynced(mac, { layaDir: layaMac })["Home.md"]);
  fs.rmSync(base, { recursive: true, force: true });
});
