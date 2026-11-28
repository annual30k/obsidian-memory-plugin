// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExport, exportToFile } from "../lib/vault-transfer/export.js";
import { applyImport, openBundle, openBundleFile, planImport } from "../lib/vault-transfer/import.js";
import { filterLayaLabels } from "../lib/vault-transfer/laya-filter.js";
import { setLocalOnly } from "../lib/vault-transfer/project-ops.js";
import { applyRollback, listImportSnapshots, planRollback, snapshotsRoot } from "../lib/vault-transfer/snapshot.js";
import { readSynced } from "../lib/vault-transfer/sync-base.js";
import { defaultEmbeddingCachePath, loadEmbeddingCache } from "../lib/memory-router/vault-index.js";
import { main as exportMain } from "../scripts/export-vault.mjs";
import { main as importMain } from "../scripts/import-vault.mjs";
import { refreshVaultIndex } from "../scripts/index-vault.mjs";
import { buildLabelRecord } from "../scripts/label-laya.mjs";

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = (f) => fs.readFileSync(f, "utf8");
const sink = () => { let s = ""; return { write: (x) => { s += x; }, get text() { return s; } }; };

function asDevice(device, fn) {
  const prev = process.env.OBSIDIAN_MEMORY_DEVICE;
  process.env.OBSIDIAN_MEMORY_DEVICE = device;
  try {
    const res = fn();
    if (res && typeof res.then === "function") {
      return res.finally(() => {
        if (prev === undefined) delete process.env.OBSIDIAN_MEMORY_DEVICE;
        else process.env.OBSIDIAN_MEMORY_DEVICE = prev;
      });
    }
    if (prev === undefined) delete process.env.OBSIDIAN_MEMORY_DEVICE;
    else process.env.OBSIDIAN_MEMORY_DEVICE = prev;
    return res;
  } catch (err) {
    if (prev === undefined) delete process.env.OBSIDIAN_MEMORY_DEVICE;
    else process.env.OBSIDIAN_MEMORY_DEVICE = prev;
    throw err;
  }
}

function makeVault(root, { projects = [] } = {}) {
  const lines = ["projects:"];
  for (const p of projects) {
    lines.push(`  - id: ${p.id}`, "    roots: []", "    scope: private");
  }
  write(path.join(root, "00-System", "projects.yaml"), lines.join("\n") + "\n");
  write(path.join(root, "AGENTS.md"), "# Vault Root\n");
  write(path.join(root, "Home.md"), "# Home\n");
  write(path.join(root, "10-Global", "preferences.md"), "---\ntitle: Prefs\n---\n\n- global pref\n");
  write(path.join(root, "10-Global", "index.md"), "# Global Index\n");
  write(path.join(root, "10-Global", "log.md"), "# Global Log\n");
  for (const p of projects) {
    write(path.join(root, "20-Projects", p.id, "AGENTS.md"), `# ${p.id}\n`);
    write(path.join(root, "20-Projects", p.id, "index.md"), `# ${p.id} Index\n`);
    write(path.join(root, "20-Projects", p.id, "log.md"), `# Log\n`);
    write(path.join(root, "20-Projects", p.id, "wiki", "knowledge", "note.md"), `---\ntitle: ${p.id}\n---\n\nbody v1 of ${p.id}\n`);
  }
  return root;
}

// ---------------------------------------------------------------- 1. Pre-import snapshot & rollback

test("import snapshot + rollback restores overwritten/deleted/added files, Laya, and sync state, and guards post-import user edits", async () => {
  const base = tmp("om-rollback-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1" }] });
  const longName = `${"很长的中文名字".repeat(12)}.md`; // 255 UTF-8 bytes
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", longName), "long v1\n");
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "to-delete.md"), "delete me\n");
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");
  write(path.join(lA, "labels.jsonl"), "{\"text\":\"q1\",\"project_id\":\"app-1\",\"label\":\"recall\"}\n");

  // Initial sync A -> B.
  const f1 = path.join(base, "f1.tar.gz");
  await asDevice("A", () => exportToFile(A, f1, { layaDir: lA }));
  const B = path.join(base, "B");
  assert.equal(
    await asDevice("B", () => importMain([f1, "--vault", B, "--yes", "--no-index"], sink(), sink(), {
      layaDir: lB, now: new Date(2026, 10, 28, 16, 0, 0), collectHosts: () => ({ hosts: [] })
    })),
    0
  );
  const syncBefore = readSynced(B, { layaDir: lB, peer: "A" });
  assert.ok(syncBefore["20-Projects/app-1/wiki/knowledge/to-delete.md"]);

  // A modifies note.md and longName, adds brand-new.md, deletes to-delete.md, and appends a Laya label.
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: app-1\n---\n\nbody v2 of app-1\n");
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", longName), "long v2\n");
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "brand-new.md"), "brand new\n");
  fs.rmSync(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "to-delete.md"));
  fs.appendFileSync(path.join(lA, "labels.jsonl"), "{\"text\":\"q2\",\"project_id\":\"app-1\",\"label\":\"recall\"}\n");

  const f2 = path.join(base, "f2.tar.gz");
  await asDevice("A", () => exportToFile(A, f2, { layaDir: lA }));
  const impOut = sink();
  assert.equal(
    await asDevice("B", () => importMain([f2, "--vault", B, "--yes", "--no-index"], impOut, sink(), {
      layaDir: lB, now: new Date(2026, 10, 28, 16, 10, 0), collectHosts: () => ({ hosts: [] })
    })),
    0
  );
  assert.match(impOut.text, /Snapshot: 20261128-161000-[0-9a-f]{4}/u);
  assert.match(impOut.text, /omem import rollback/u);
  assert.ok(!fs.existsSync(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "to-delete.md")), "remote deletion applied");
  assert.ok(fs.existsSync(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "brand-new.md")));
  assert.ok(!fs.existsSync(path.join(B, "00-System", "backups")), "snapshots stay strictly outside the Vault");
  assert.ok(fs.existsSync(snapshotsRoot(B, { layaDir: lB })));

  // --list shows snapshots.
  const listOut = sink();
  assert.equal(await importMain(["rollback", "--list", "--vault", B], listOut, sink(), { layaDir: lB }), 0);
  const snaps = listImportSnapshots(B, { layaDir: lB });
  assert.equal(snaps.length, 2);
  const latestId = snaps[0].id;
  assert.match(listOut.text, new RegExp(latestId, "u"));

  // Anti-clobber: user manually edits brand-new.md after the import -> rollback refuses without --force!
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "brand-new.md"), "user added manual edits!\n");
  const dryBlocked = sink();
  assert.equal(await importMain(["rollback", latestId, "--vault", B, "--no-index"], dryBlocked, sink(), { layaDir: lB }), 0);
  assert.match(dryBlocked.text, /modified after the import.*block rollback without --force/u);
  const errBlocked = sink();
  assert.equal(await importMain(["rollback", latestId, "--vault", B, "--yes", "--no-index"], sink(), errBlocked, { layaDir: lB }), 1);
  assert.match(errBlocked.text, /refusing to roll back.*brand-new\.md.*--force/u);
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "brand-new.md")), "user added manual edits!\n", "manual edit untouched");

  // With --force, rollback proceeds and restores everything byte-for-byte including 255-byte name, deleted note, Laya, and sync state!
  const rbOut = sink();
  assert.equal(await importMain(["rollback", latestId, "--vault", B, "--yes", "--force", "--no-index"], rbOut, sink(), { layaDir: lB }), 0);
  assert.match(rbOut.text, /Rolled back:/u);
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), "---\ntitle: app-1\n---\n\nbody v1 of app-1\n");
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", longName)), "long v1\n");
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "to-delete.md")), "delete me\n");
  assert.ok(!fs.existsSync(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "brand-new.md")));
  assert.equal(read(path.join(lB, "labels.jsonl")), "{\"text\":\"q1\",\"project_id\":\"app-1\",\"label\":\"recall\"}\n");
  assert.deepEqual(readSynced(B, { layaDir: lB, peer: "A" }), syncBefore, "sync baseline restored exactly");

  // --no-backup skips creating a new snapshot; retention prunes beyond keepLast.
  const countBefore = listImportSnapshots(B, { layaDir: lB }).length;
  assert.equal(
    await asDevice("B", () => importMain([f2, "--vault", B, "--yes", "--no-backup", "--no-index"], sink(), sink(), { layaDir: lB, collectHosts: () => ({ hosts: [] }) })),
    0
  );
  assert.equal(listImportSnapshots(B, { layaDir: lB }).length, countBefore, "--no-backup created no snapshot");
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 2. Auto-refresh Laya vector index

test("import and rollback automatically refresh Laya embeddings, prune deleted vectors, degrade gracefully when offline, and honour --no-index", async () => {
  const base = tmp("om-autoindex-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1" }] });
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");
  const f1 = path.join(base, "f1.tar.gz");
  await asDevice("A", () => exportToFile(A, f1, { layaDir: lA }));

  // Mock embedding router: returns deterministic 4D unit vectors.
  const mockRouterFactory = () => ({
    healthInfo: { backend: "mock", capabilities: ["embed"] },
    async embedTexts(texts) {
      return { model: "mock-e5", vectors: texts.map(() => [0.5, 0.5, 0.5, 0.5]) };
    },
    dispose() {}
  });
  const B = path.join(base, "B");
  const outImp = sink();
  assert.equal(
    await asDevice("B", () => importMain([f1, "--vault", B, "--yes"], outImp, sink(), {
      layaDir: lB,
      collectHosts: () => ({ hosts: [] }),
      refreshIndex: (opts) => refreshVaultIndex({ ...opts, createRouter: mockRouterFactory })
    })),
    0
  );
  assert.match(outImp.text, /Index refreshed: \d+ notes \(\d+ embedded\)/u);
  const embPath = path.join(lB, "cache", path.basename(defaultEmbeddingCachePath()));
  const cacheAfterImport = loadEmbeddingCache(embPath, { vaultPath: B, model: "mock-e5" });
  const noteKey = Object.keys(cacheAfterImport.entries).find((k) => k.includes("20-Projects/app-1/wiki/knowledge/note.md"));
  assert.ok(noteKey, "imported note was embedded");

  // Add one more note, import, then roll back -> rolled-back note's vector is pruned immediately!
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "extra.md"), "---\ntitle: Extra\n---\n\nextra body\n");
  const f2 = path.join(base, "f2.tar.gz");
  await asDevice("A", () => exportToFile(A, f2, { layaDir: lA }));
  await asDevice("B", () => importMain([f2, "--vault", B, "--yes"], sink(), sink(), {
    layaDir: lB,
    collectHosts: () => ({ hosts: [] }),
    refreshIndex: (opts) => refreshVaultIndex({ ...opts, createRouter: mockRouterFactory })
  }));
  const cache2 = loadEmbeddingCache(embPath, { vaultPath: B, model: "mock-e5" });
  assert.ok(Object.keys(cache2.entries).some((k) => k.includes("extra.md")), "extra.md embedded");

  const outRb = sink();
  assert.equal(
    await importMain(["rollback", "--vault", B, "--yes"], outRb, sink(), {
      layaDir: lB,
      refreshIndex: (opts) => refreshVaultIndex({ ...opts, createRouter: mockRouterFactory })
    }),
    0
  );
  assert.match(outRb.text, /Index refreshed:.*stale vector\(s\) pruned/u);
  const cache3 = loadEmbeddingCache(embPath, { vaultPath: B, model: "mock-e5" });
  assert.ok(!Object.keys(cache3.entries).some((k) => k.includes("extra.md")), "ghost vector for rolled-back note was pruned");

  // Graceful degradation when Laya service is NOT running (does not fail import!).
  const outOffline = sink();
  assert.equal(
    await asDevice("B", () => importMain([f2, "--vault", B, "--yes"], outOffline, sink(), {
      layaDir: lB, collectHosts: () => ({ hosts: [] })
    })),
    0
  );
  assert.match(outOffline.text, /Index not refreshed.*omem index/u);

  // --no-index skips refreshIndex completely.
  let refreshCalled = false;
  assert.equal(
    await importMain(["rollback", "--vault", B, "--yes", "--no-index"], sink(), sink(), {
      layaDir: lB,
      refreshIndex: async () => { refreshCalled = true; return { ok: true }; }
    }),
    0
  );
  assert.equal(refreshCalled, false);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 3. Fine-grained Laya label filtering

test("Laya labels carry project_id/scope and are filtered per project on export (transfer: local, --project) and import (--only-project, --skip-project)", async () => {
  // New label records carry project_id / scope while remaining compatible with legacy items.
  const recProj = buildLabelRecord({ text: "project q", action: "recall", score: 0.8, project_id: "app-1", scope: "project" }, "y", new Date("2026-11-28T00:00:00Z"));
  assert.equal(recProj.project_id, "app-1");
  assert.equal(recProj.scope, "project");
  const recLegacy = buildLabelRecord({ text: "legacy q", action: "none", score: 0.1 }, "n", new Date("2026-11-28T00:00:00Z"));
  assert.equal(recLegacy.project_id, undefined);

  const base = tmp("om-laya-filter-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1" }, { id: "app-2" }, { id: "priv-local" }] });
  setLocalOnly(A, "priv-local", true, { apply: true });
  const lA = path.join(base, "lA");
  const sampleLabels = [
    JSON.stringify({ text: "app-1 prompt", project_id: "app-1", scope: "project", label: "recall" }),
    JSON.stringify({ text: "app-2 prompt", project_id: "app-2", scope: "project", label: "recall" }),
    JSON.stringify({ text: "secret local prompt", project_id: "priv-local", scope: "project", label: "recall" }),
    JSON.stringify({ text: "global pref prompt", scope: "global", label: "capture" }),
    JSON.stringify({ text: "legacy unattributed prompt", label: "recall" })
  ].join("\n") + "\n";
  write(path.join(lA, "labels.jsonl"), sampleLabels);

  // Export with transfer: local -> keeps app-1, app-2, global; drops priv-local AND unattributed legacy!
  const expOut = sink();
  const outFile = path.join(base, "exp.tar.gz");
  assert.equal(await asDevice("A", () => exportMain(["--vault", A, "--out", outFile], expOut, sink(), { layaDir: lA })), 0);
  assert.match(expOut.text, /Laya labels filtered: kept 3, filtered 2 \(1 excluded project, 1 unattributed legacy\)/u);
  const opened = await openBundleFile(outFile);
  const exportedLabels = opened.entries.find((e) => e.path === "laya/labels.jsonl").data.toString("utf8");
  assert.match(exportedLabels, /app-1 prompt/u);
  assert.match(exportedLabels, /app-2 prompt/u);
  assert.match(exportedLabels, /global pref prompt/u);
  assert.doesNotMatch(exportedLabels, /secret local prompt/u);
  assert.doesNotMatch(exportedLabels, /legacy unattributed prompt/u);

  // Export with --project app-1 --no-global -> keeps ONLY app-1 labels (drops app-2, global, priv-local, legacy).
  const projExp = buildExport(A, { layaDir: lA, projects: ["app-1"], withGlobal: false });
  assert.deepEqual(projExp.layaFilter, { kept: 1, droppedProject: 2, droppedScope: 1, droppedUnattributed: 1, total: 5 });
  const projLabels = openBundle(projExp.bundle).entries.find((e) => e.path === "laya/labels.jsonl").data.toString("utf8");
  assert.match(projLabels, /app-1 prompt/u);
  assert.doesNotMatch(projLabels, /app-2 prompt|global pref|secret local|legacy/u);

  // --no-laya excludes all Laya files even when attributed labels exist.
  const noLayaExp = buildExport(A, { layaDir: lA, withLaya: false });
  assert.ok(!noLayaExp.manifest.files.some((f) => f.path.startsWith("laya/")));

  // Import side: --only-project app-1 --with-laya filters incoming labels to ONLY app-1!
  const B = makeVault(path.join(base, "B"), { projects: [{ id: "app-1" }, { id: "app-2" }] });
  const lB = path.join(base, "lB");
  const impOut = sink();
  assert.equal(
    await asDevice("B", () => importMain([outFile, "--vault", B, "--only-project", "app-1", "--with-laya", "--yes", "--no-index"], impOut, sink(), {
      layaDir: lB, collectHosts: () => ({ hosts: [] })
    })),
    0
  );
  assert.match(impOut.text, /labels filtered by import scope: kept 1, filtered 2 \(1 excluded project, 1 excluded global\)/u);
  const importedLabels = read(path.join(lB, "labels.jsonl"));
  assert.match(importedLabels, /app-1 prompt/u);
  assert.doesNotMatch(importedLabels, /app-2 prompt|global pref/u);

  // Direct unit check on filterLayaLabels.
  const f = filterLayaLabels(sampleLabels, { excludeProjects: new Set(["priv-local"]), includeGlobal: false, keepUnattributed: false });
  assert.equal(f.kept, 2);
  assert.equal(f.droppedProject, 1);
  assert.equal(f.droppedScope, 1);
  assert.equal(f.droppedUnattributed, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 4. Remote rename & deletion propagation

test("rename detection, rename/modify conflict, remote deletion propagation, delete/modify conflict, incremental unchanged safety, and scope/core protection", async () => {
  const base = tmp("om-rename-del-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1" }, { id: "app-2" }, { id: "local-only" }] });
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "old-name.md"), "unique rename body\n");
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "conflict-rename.md"), "conflict rename body\n");
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "del-clean.md"), "delete clean body\n");
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "del-conflict.md"), "delete conflict body\n");
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "stay-unchanged.md"), "unchanged body\n");
  write(path.join(A, "20-Projects", "app-2", "wiki", "knowledge", "app2-del.md"), "app2 delete body\n");
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");

  // Full initial sync A -> B, then B -> A so both sides have full baselines.
  const f0 = asDevice("A", () => buildExport(A, { layaDir: lA }).bundle);
  const B = path.join(base, "B");
  asDevice("B", () => applyImport(planImport(f0, { targetVault: B, layaDir: lB, includeLaya: false })));
  const b0 = asDevice("B", () => buildExport(B, { layaDir: lB }).bundle);
  asDevice("A", () => applyImport(planImport(b0, { targetVault: A, layaDir: lA, includeLaya: false })));

  // On A:
  // 1) Clean rename: old-name.md -> new-name.md
  fs.renameSync(
    path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "old-name.md"),
    path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "new-name.md")
  );
  // 2) Rename while B edits old path: conflict-rename.md -> conflict-renamed.md
  fs.renameSync(
    path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "conflict-rename.md"),
    path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "conflict-renamed.md")
  );
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "conflict-rename.md"), "conflict rename body + local edits on B\n");
  // 3) Clean deletion: del-clean.md
  fs.rmSync(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "del-clean.md"));
  // 4) Delete/modify conflict: del-conflict.md deleted on A, edited on B
  fs.rmSync(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "del-conflict.md"));
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "del-conflict.md"), "local edits saved on B\n");
  // 5) Deletion in app-2 (will be out of scope when B imports --only-project app-1!)
  fs.rmSync(path.join(A, "20-Projects", "app-2", "wiki", "knowledge", "app2-del.md"));
  // 6) Mark local-only as transfer: local on A -> its files disappear from A's export, MUST NOT be deleted on B!
  setLocalOnly(A, "local-only", true, { apply: true });
  // 7) Delete a protected core file on A (Home.md) -> MUST NOT be auto-deleted on B!
  fs.rmSync(path.join(A, "Home.md"));

  // Export INCREMENTAL bundle from A targeting B!
  const incFile = path.join(base, "inc-a.tar.gz");
  await asDevice("A", () => exportToFile(A, incFile, { layaDir: lA, incremental: true }));

  // First test with --only-project app-1: app2-del.md MUST NOT be touched!
  const dryOnly = sink();
  assert.equal(await asDevice("B", () => importMain([incFile, "--vault", B, "--only-project", "app-1"], dryOnly, sink(), { layaDir: lB })), 0);
  assert.match(dryOnly.text, /Renamed on the other machine.*old-name\.md -> .*new-name\.md/su);
  assert.match(dryOnly.text, /Deleted on the other machine.*del-clean\.md/su);
  assert.match(dryOnly.text, /Delete\/modify conflict\(s\).*del-conflict\.md/su);
  assert.match(dryOnly.text, /conflict \(rename\/modify\).*conflict-rename\.md -> .*conflict-renamed\.md/u);
  assert.doesNotMatch(dryOnly.text, /app2-del\.md/u);
  assert.doesNotMatch(dryOnly.text, /stay-unchanged\.md/u);
  assert.doesNotMatch(dryOnly.text, /local-only/u);
  assert.doesNotMatch(dryOnly.text, /Home\.md/u);

  // Apply with --only-project app-1 --yes!
  assert.equal(
    await asDevice("B", () => importMain([incFile, "--vault", B, "--only-project", "app-1", "--yes", "--no-index"], sink(), sink(), {
      layaDir: lB, collectHosts: () => ({ hosts: [] })
    })),
    0
  );
  assert.ok(!fs.existsSync(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "old-name.md")), "old path removed on clean rename");
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "new-name.md")), "unique rename body\n", "new path created on clean rename");
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "conflict-rename.md")), "conflict rename body + local edits on B\n", "rename/modify kept local edits");
  assert.ok(!fs.existsSync(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "conflict-renamed.md")), "rename/modify parked incoming in conflicts, not duplicated directly");
  assert.ok(!fs.existsSync(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "del-clean.md")), "clean deletion propagated");
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "del-conflict.md")), "local edits saved on B\n", "delete/modify kept local edits");
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "stay-unchanged.md")), "unchanged body\n", "incremental unchanged file kept intact");
  assert.equal(read(path.join(B, "20-Projects", "app-2", "wiki", "knowledge", "app2-del.md")), "app2 delete body\n", "out-of-scope app-2 file untouched");
  assert.equal(read(path.join(B, "20-Projects", "local-only", "wiki", "knowledge", "note.md")), "---\ntitle: local-only\n---\n\nbody v1 of local-only\n", "exporter transfer: local project never deleted on target");
  assert.equal(read(path.join(B, "Home.md")), "# Home\n", "protected core file never auto-deleted");

  // One-click rollback undoes BOTH the rename and the deletion!
  const rbPlan = planRollback(B, { layaDir: lB });
  assert.ok(rbPlan.restore.some((r) => r.rel.endsWith("old-name.md")));
  assert.ok(rbPlan.restore.some((r) => r.rel.endsWith("del-clean.md")));
  assert.ok(rbPlan.remove.some((r) => r.rel.endsWith("new-name.md")));
  applyRollback(rbPlan);
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "old-name.md")), "unique rename body\n");
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "del-clean.md")), "delete clean body\n");
  assert.ok(!fs.existsSync(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "new-name.md")));

  // Full-scope import of incFile still protects Home.md and local-only (exporter's transfer: local), while propagating app2-del.md!
  const fullPlan = await asDevice("B", async () => planImport(await openBundleFile(incFile, { stagingDir: path.join(base, "st-full") }), { targetVault: B, layaDir: lB, includeLaya: false }));
  assert.ok(fullPlan.vault.deletedThere.includes("20-Projects/app-2/wiki/knowledge/app2-del.md"));
  assert.ok(!fullPlan.vault.deletedThere.includes("Home.md"), "Home.md protected even in full scope");
  assert.ok(!fullPlan.vault.deletedThere.some((r) => r.includes("local-only")), "exporter transfer: local protected even in full scope");
  fs.rmSync(base, { recursive: true, force: true });
});
