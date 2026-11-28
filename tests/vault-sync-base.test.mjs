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
import { deviceName } from "../lib/vault-ingest.js";

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
  assert.ok(Object.keys(readSynced(win, { layaDir: layaWin, peer: deviceName() })).includes("Home.md"), "the import recorded what both now agree on");

  // Windows: edits Home and x, CRLF-only rewrite of preferences. Mac: edits AGENTS, deletes gone.md.
  write(path.join(win, "Home.md"), "# Home\n\n- from Windows\n");
  write(path.join(win, "10-Global", "wiki", "knowledge", "x.md"), "x v2 (Windows)\n");
  write(path.join(win, "10-Global", "preferences.md"), "- a\r\n");
  write(path.join(mac, "AGENTS.md"), "# Vault\n\nEdited on the Mac.\n");
  fs.rmSync(path.join(mac, "10-Global", "wiki", "knowledge", "gone.md"));
  const e2 = buildExport(win, { layaDir: layaWin }).bundle;
  assert.ok(Object.keys(openBundle(e2).manifest.syncedByDevice[deviceName()] ?? {}).includes("vault/Home.md"), "the export carries its record");

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
  assert.equal(syncHash("Home.md", read(path.join(mac, "Home.md"))), readSynced(mac, { layaDir: layaMac, peer: deviceName() })["Home.md"]);
  fs.rmSync(base, { recursive: true, force: true });
});

test("three machines: records are per machine, so a machine that never synced cannot roll a file back", () => {
  const base = tmp("om-sync3-");
  const as = (device, fn) => { const prev = process.env.OBSIDIAN_MEMORY_DEVICE; process.env.OBSIDIAN_MEMORY_DEVICE = device; try { return fn(); } finally { if (prev === undefined) delete process.env.OBSIDIAN_MEMORY_DEVICE; else process.env.OBSIDIAN_MEMORY_DEVICE = prev; } };
  const L = (n) => path.join(base, `laya-${n}`);
  const A = seed(path.join(base, "A"));
  const B = path.join(base, "B");
  const C = path.join(base, "C");
  // B and C both start from A's first export.
  const first = as("A", () => buildExport(A, { layaDir: L("A") }).bundle);
  as("B", () => applyImport(planImport(first, { targetVault: B, layaDir: L("B"), includeLaya: false })));
  as("C", () => applyImport(planImport(first, { targetVault: C, layaDir: L("C"), includeLaya: false })));
  // A edits Home and syncs it with B (both ways), so A and B agree on the new version.
  write(path.join(A, "Home.md"), "# Home\n\n- v2 from A\n");
  as("B", () => applyImport(planImport(as("A", () => buildExport(A, { layaDir: L("A") }).bundle), { targetVault: B, layaDir: L("B"), includeLaya: false })));
  as("A", () => applyImport(planImport(as("B", () => buildExport(B, { layaDir: L("B") }).bundle), { targetVault: A, layaDir: L("A"), includeLaya: false })));
  assert.deepEqual(Object.keys(syncedPeersOf(A, L("A"))).sort(), ["B"], "A has a record for B only");
  // C, still on v1, exports to A. A's record for C (from nothing) cannot vouch for v1: no silent rollback.
  const fromC = as("A", () => planImport(as("C", () => buildExport(C, { layaDir: L("C") }).bundle), { targetVault: A, layaDir: L("A"), includeLaya: false }));
  assert.ok(!fromC.vault.fastForward.includes("Home.md"), "A's v2 is not replaced by C's older v1");
  assert.equal(read(path.join(A, "Home.md")), "# Home\n\n- v2 from A\n");
  fs.rmSync(base, { recursive: true, force: true });
});

function syncedPeersOf(vault, layaDir) {
  return JSON.parse(fs.readFileSync(syncStatePath(vault, { layaDir }), "utf8")).peers;
}

test("a deleted or emptied Vault imported again gets everything back, not 'deleted here'", () => {
  const base = tmp("om-sync-stale-");
  const src = seed(path.join(base, "src"));
  for (let i = 0; i < 30; i++) write(path.join(src, "10-Global", "wiki", "knowledge", `n${i}.md`), `note ${i}\n`);
  const bundle = buildExport(src, { layaDir: path.join(base, "l0") }).bundle;
  const target = path.join(base, "t");
  const laya = path.join(base, "laya");
  applyImport(planImport(bundle, { targetVault: target, layaDir: laya, includeLaya: false }));
  fs.rmSync(target, { recursive: true, force: true });               // the Vault is deleted; the record stays
  const fresh = planImport(bundle, { targetVault: target, layaDir: laya, includeLaya: false });
  assert.deepEqual(fresh.vault.deletedHere, [], "an empty folder ignores old records");
  assert.ok(fresh.vault.add.length >= 30);
  // Most files removed but the folder still a Vault: the record is recognised as stale.
  applyImport(fresh);
  for (let i = 0; i < 30; i++) fs.rmSync(path.join(target, "10-Global", "wiki", "knowledge", `n${i}.md`));
  const partial = planImport(bundle, { targetVault: target, layaDir: laya, includeLaya: false });
  assert.match(partial.warnings.join("\n"), /sync record for this Vault looks stale/u);
  assert.equal(partial.vault.deletedHere.length, 0);
  // A few deliberate deletions in a healthy Vault are still respected.
  applyImport(partial);
  fs.rmSync(path.join(target, "10-Global", "wiki", "knowledge", "n0.md"));
  assert.deepEqual(planImport(bundle, { targetVault: target, layaDir: laya, includeLaya: false }).vault.deletedHere, ["10-Global/wiki/knowledge/n0.md"]);
  fs.rmSync(base, { recursive: true, force: true });
});
