// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExport } from "../lib/vault-transfer/export.js";
import { applyImport, openBundle, planImport } from "../lib/vault-transfer/import.js";
import { setLocalOnly } from "../lib/vault-transfer/project-ops.js";
import { applyRollback, listImportSnapshots, planRollback } from "../lib/vault-transfer/snapshot.js";
import { ancestorsFromBundle, readSynced } from "../lib/vault-transfer/sync-base.js";

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = (f) => fs.readFileSync(f, "utf8");

function asDevice(device, fn) {
  const prev = process.env.OBSIDIAN_MEMORY_DEVICE;
  process.env.OBSIDIAN_MEMORY_DEVICE = device;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.OBSIDIAN_MEMORY_DEVICE;
    else process.env.OBSIDIAN_MEMORY_DEVICE = prev;
  }
}

function makeVault(root, { projects = [] } = {}) {
  const lines = ["projects:"];
  for (const p of projects) lines.push(`  - id: ${p}`, "    roots: []", "    scope: private");
  write(path.join(root, "00-System", "projects.yaml"), lines.join("\n") + "\n");
  write(path.join(root, "AGENTS.md"), "# Vault Root\n");
  write(path.join(root, "Home.md"), "# Home\n");
  write(path.join(root, "10-Global", "preferences.md"), "---\ntitle: Prefs\n---\n\n- global pref\n");
  write(path.join(root, "10-Global", "index.md"), "# Global Index\n");
  write(path.join(root, "10-Global", "log.md"), "# Global Log\n");
  for (const p of projects) {
    write(path.join(root, "20-Projects", p, "AGENTS.md"), `# ${p}\n`);
    write(path.join(root, "20-Projects", p, "index.md"), `# ${p} Index\n`);
    write(path.join(root, "20-Projects", p, "log.md"), "# Log\n");
    write(path.join(root, "20-Projects", p, "wiki", "knowledge", "note.md"), `---\ntitle: ${p}\n---\n\nbody v1 of ${p}\n`);
  }
  return root;
}

const kn = (vault, project, name) => path.join(vault, "20-Projects", project, "wiki", "knowledge", name);

test("decisions.jsonl is filtered per project like the labels (transfer: local prompts never leave)", () => {
  const base = tmp("om-fix-decisions-");
  const A = makeVault(path.join(base, "A"), { projects: ["app-1", "priv-local"] });
  setLocalOnly(A, "priv-local", true, { apply: true });
  const lA = path.join(base, "lA");
  write(path.join(lA, "decisions.jsonl"), [
    JSON.stringify({ prompt: "app-1 question", project_id: "app-1", scope: "project" }),
    JSON.stringify({ prompt: "secret local question", project_id: "priv-local", scope: "project" }),
    JSON.stringify({ prompt: "unattributed old question" })
  ].join("\n") + "\n");

  const exp = buildExport(A, { layaDir: lA, withDecisions: true });
  const entry = openBundle(exp.bundle).entries.find((e) => e.path === "laya/decisions.jsonl");
  assert.ok(entry, "decisions.jsonl exported on request");
  const text = entry.data.toString("utf8");
  assert.match(text, /app-1 question/u);
  assert.doesNotMatch(text, /secret local question/u);
  assert.doesNotMatch(text, /unattributed old question/u);
  fs.rmSync(base, { recursive: true, force: true });
});

test("--base alone never deletes: files the other machine may never have received are only reported", () => {
  const base = tmp("om-fix-base-");
  const A = makeVault(path.join(base, "A"), { projects: ["app-1"] });
  write(path.join(A, "10-Global", "wiki", "a-only.md"), "only on A\n");
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");
  const f0 = asDevice("A", () => buildExport(A, { layaDir: lA }).bundle);

  // B imports A's bundle without 10-Global, so it never gets a-only.md.
  const B = makeVault(path.join(base, "B"), { projects: ["app-1"] });
  asDevice("B", () => applyImport(planImport(f0, { targetVault: B, layaDir: lB, includeLaya: false, withGlobal: false }), { backup: false }));
  assert.ok(!fs.existsSync(path.join(B, "10-Global", "wiki", "a-only.md")));

  // A imports B's bundle with the first bundle as --base: a-only.md must stay on A.
  const b1 = asDevice("B", () => buildExport(B, { layaDir: lB }).bundle);
  const plan = asDevice("A", () => planImport(b1, { targetVault: A, layaDir: lA, includeLaya: false, base: ancestorsFromBundle(openBundle(f0)) }));
  assert.ok(plan.vault.missingThere.includes("10-Global/wiki/a-only.md"), "reported");
  assert.ok(!plan.vault.deletedThere.includes("10-Global/wiki/a-only.md"), "not propagated as a deletion");
  asDevice("A", () => applyImport(plan, { backup: false }));
  assert.equal(read(path.join(A, "10-Global", "wiki", "a-only.md")), "only on A\n");
  fs.rmSync(base, { recursive: true, force: true });
});

test("identical content in several places is not paired as a rename", () => {
  const base = tmp("om-fix-rename-");
  const A = makeVault(path.join(base, "A"), { projects: ["app-1"] });
  write(kn(A, "app-1", "t1.md"), "same template\n");
  write(kn(A, "app-1", "t2.md"), "same template\n");
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");
  const B = path.join(base, "B");
  asDevice("B", () => applyImport(planImport(asDevice("A", () => buildExport(A, { layaDir: lA }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }), { backup: false }));

  // A deletes both copies and creates a third with the same content; B edits t1.md.
  fs.rmSync(kn(A, "app-1", "t1.md"));
  fs.rmSync(kn(A, "app-1", "t2.md"));
  write(kn(A, "app-1", "t3.md"), "same template\n");
  write(kn(B, "app-1", "t1.md"), "same template\nedited on B\n");

  const plan = asDevice("B", () => planImport(asDevice("A", () => buildExport(A, { layaDir: lA }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }));
  assert.deepEqual(plan.vault.renamed, []);
  assert.deepEqual(plan.vault.renameConflicts, []);
  assert.ok(plan.vault.deletedThere.includes("20-Projects/app-1/wiki/knowledge/t2.md"));
  assert.ok(plan.vault.deleteConflicts.some((d) => d.rel === "20-Projects/app-1/wiki/knowledge/t1.md"));
  asDevice("B", () => applyImport(plan, { backup: false }));
  assert.equal(read(kn(B, "app-1", "t3.md")), "same template\n", "new file added normally");
  assert.equal(read(kn(B, "app-1", "t1.md")), "same template\nedited on B\n", "local edit kept");
  assert.ok(!fs.existsSync(kn(B, "app-1", "t2.md")));

  // A unique match is still a rename.
  write(kn(A, "app-1", "solo.md"), "solo body\n");
  asDevice("B", () => applyImport(planImport(asDevice("A", () => buildExport(A, { layaDir: lA }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }), { backup: false }));
  fs.renameSync(kn(A, "app-1", "solo.md"), kn(A, "app-1", "solo-renamed.md"));
  const plan2 = asDevice("B", () => planImport(asDevice("A", () => buildExport(A, { layaDir: lA }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }));
  assert.deepEqual(plan2.vault.renamed, [{ from: "20-Projects/app-1/wiki/knowledge/solo.md", to: "20-Projects/app-1/wiki/knowledge/solo-renamed.md" }]);
  fs.rmSync(base, { recursive: true, force: true });
});

test("an import that fails part-way keeps a snapshot that rolls back what was written", () => {
  const base = tmp("om-fix-failed-");
  const A = makeVault(path.join(base, "A"), { projects: ["app-1"] });
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");
  const B = path.join(base, "B");
  asDevice("B", () => applyImport(planImport(asDevice("A", () => buildExport(A, { layaDir: lA }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }), { backup: false }));
  const syncBefore = readSynced(B, { layaDir: lB, peer: "A" });

  write(kn(A, "app-1", "note.md"), "---\ntitle: app-1\n---\n\nbody v2 of app-1\n");
  const plan = asDevice("B", () => planImport(asDevice("A", () => buildExport(A, { layaDir: lA }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }));
  // A last write that cannot succeed (its parent is a file), after the real ones.
  plan.writes.push({ abs: path.join(B, "Home.md", "x.md"), data: Buffer.from("x") });
  assert.throws(() => applyImport(plan, { now: new Date(2026, 10, 28, 9, 0, 0) }), /stopped part-way.*omem import rollback/su);
  assert.match(read(kn(B, "app-1", "note.md")), /body v2/u, "the real write happened before the failure");

  const snaps = listImportSnapshots(B, { layaDir: lB });
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].status, "failed");
  applyRollback(planRollback(B, { layaDir: lB }));
  assert.match(read(kn(B, "app-1", "note.md")), /body v1/u);
  assert.deepEqual(readSynced(B, { layaDir: lB, peer: "A" }), syncBefore);
  fs.rmSync(base, { recursive: true, force: true });
});

test("rolling back an older import keeps other machines' sync records", () => {
  const base = tmp("om-fix-rb-peers-");
  const A = makeVault(path.join(base, "A"), { projects: ["app-1"] });
  const C = makeVault(path.join(base, "C"), { projects: ["app-9"] });
  const lB = path.join(base, "lB");
  const B = path.join(base, "B"); // a fresh copy of A first, so that import has a snapshot

  asDevice("B", () => applyImport(planImport(asDevice("A", () => buildExport(A, { layaDir: path.join(base, "lA") }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }), { now: new Date(2026, 10, 28, 10, 0, 0) }));
  const fromA = listImportSnapshots(B, { layaDir: lB })[0].id;
  asDevice("B", () => applyImport(planImport(asDevice("C", () => buildExport(C, { layaDir: path.join(base, "lC") }).bundle), { targetVault: B, layaDir: lB, includeLaya: false }), { now: new Date(2026, 10, 28, 11, 0, 0) }));
  const cRecord = readSynced(B, { layaDir: lB, peer: "C" });
  assert.ok(Object.keys(cRecord).length > 0);
  assert.ok(Object.keys(readSynced(B, { layaDir: lB, peer: "A" })).length > 0);

  applyRollback(planRollback(B, { layaDir: lB, snapshotId: fromA, force: true }));
  assert.deepEqual(readSynced(B, { layaDir: lB, peer: "C" }), cRecord, "C's baseline survives");
  assert.deepEqual(readSynced(B, { layaDir: lB, peer: "A" }), {}, "A's record is back to before its import");
  fs.rmSync(base, { recursive: true, force: true });
});
