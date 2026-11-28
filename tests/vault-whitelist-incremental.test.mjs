// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTarGz, isEncrypted, readTarGz } from "../lib/vault-transfer/archive.js";
import {
  BUNDLE_FORMAT_VERSION, FULL_BUNDLE_FORMAT_VERSION, INCREMENTAL_BUNDLE_FORMAT_VERSION,
  buildExport, exportToFile
} from "../lib/vault-transfer/export.js";
import { applyImport, openBundle, openBundleFile, planImport } from "../lib/vault-transfer/import.js";
import { parseProjectsYaml } from "../lib/vault-transfer/projects.js";
import { setLocalOnly } from "../lib/vault-transfer/project-ops.js";
import { readSynced, syncHash } from "../lib/vault-transfer/sync-base.js";
import { hashTextFileNormalizedSync } from "../lib/vault-transfer/stream.js";
import { main as exportMain } from "../scripts/export-vault.mjs";
import { main as importMain } from "../scripts/import-vault.mjs";

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
  const lines = ["# projects registry", "projects:"];
  for (const p of projects) {
    lines.push(`  - id: ${p.id}`, "    roots:", ...(p.roots ?? []).map((r) => `      - "${r}"`));
    if (!(p.roots ?? []).length) lines[lines.length - 1] = "    roots: []";
    if (p.remotes?.length) lines.push("    remotes:", ...p.remotes.map((r) => `      - ${r}`));
    lines.push("    scope: private");
  }
  write(path.join(root, "00-System", "projects.yaml"), lines.join("\n") + "\n");
  write(path.join(root, "AGENTS.md"), "# Vault Root\n");
  write(path.join(root, "Home.md"), "# Home\n");
  write(path.join(root, "30-Shared", "shared.md"), "# Shared\n");
  write(path.join(root, "10-Global", "preferences.md"), "---\ntitle: Prefs\n---\n\n- pref from source\n");
  write(path.join(root, "10-Global", "index.md"), "# Global Index\n");
  write(path.join(root, "10-Global", "log.md"), "# Global Log\n\n## [2026-10-01] ingest | global\n\n- g1\n");
  for (const p of projects) {
    write(path.join(root, "20-Projects", p.id, "AGENTS.md"), `# ${p.id}\n`);
    write(path.join(root, "20-Projects", p.id, "log.md"), `# Log\n\n## [2026-10-02] ingest | init\n\n- ${p.id}\n`);
    write(path.join(root, "20-Projects", p.id, "wiki", "knowledge", "note.md"), `---\ntitle: ${p.id}\n---\n\nbody of ${p.id}\n`);
    fs.mkdirSync(path.join(root, "20-Projects", p.id, "checkpoints"), { recursive: true });
  }
  return root;
}

// ---------------------------------------------------------------- 1. Import whitelist & anti-pollution

test("--only-project imports only selected project(s), skips 10-Global and Laya by default, and supports --with-global / --with-laya", async () => {
  const base = tmp("om-whitelist-");
  const src = makeVault(path.join(base, "src"), {
    projects: [{ id: "alpha-1", roots: ["/src/alpha"] }, { id: "beta-2", roots: ["/src/beta"] }, { id: "gamma-3", roots: ["/src/gamma"] }]
  });
  const srcLaya = path.join(base, "laya-src");
  write(path.join(srcLaya, "labels.jsonl"), "{\"prompt\":\"from src\"}\n");
  const bundleFile = path.join(base, "full.tar.gz");
  await asDevice("SRC", () => exportToFile(src, bundleFile, { layaDir: srcLaya }));

  // Target Vault has its own Global preferences, root Home.md, and existing project local-0.
  const dst = makeVault(path.join(base, "dst"), { projects: [{ id: "local-0", roots: ["/dst/local"] }] });
  write(path.join(dst, "Home.md"), "# My Local Home\n");
  write(path.join(dst, "10-Global", "preferences.md"), "---\ntitle: Prefs\n---\n\n- my own local pref\n");
  const dstLaya = path.join(base, "laya-dst");
  write(path.join(dstLaya, "labels.jsonl"), "{\"prompt\":\"local only\"}\n");

  // Single --only-project via CLI dry-run + apply.
  const dryOut = sink();
  assert.equal(await asDevice("DST", () => importMain([bundleFile, "--vault", dst, "--only-project", "alpha-1"], dryOut, sink(), { layaDir: dstLaya })), 0);
  assert.match(dryOut.text, /Import scope: only project\(s\) alpha-1; 10-Global skipped; Laya skipped/u);
  assert.match(dryOut.text, /Skipped project\(s\): beta-2, gamma-3/u);
  assert.ok(!fs.existsSync(path.join(dst, "20-Projects", "alpha-1")), "dry run writes nothing");

  const applyOut = sink();
  assert.equal(
    await asDevice("DST", () => importMain([bundleFile, "--vault", dst, "--only-project", "alpha-1", "--yes"], applyOut, sink(), { layaDir: dstLaya, collectHosts: () => ({ hosts: [] }) })),
    0
  );
  assert.match(applyOut.text, /Import scope: only project\(s\) alpha-1; 10-Global skipped; Laya skipped/u);
  assert.ok(fs.existsSync(path.join(dst, "20-Projects", "alpha-1", "wiki", "knowledge", "note.md")));
  assert.ok(fs.existsSync(path.join(dst, "20-Projects", "alpha-1", "checkpoints")));
  assert.ok(!fs.existsSync(path.join(dst, "20-Projects", "beta-2")), "beta-2 excluded");
  assert.ok(!fs.existsSync(path.join(dst, "20-Projects", "gamma-3")), "gamma-3 excluded");
  assert.equal(read(path.join(dst, "Home.md")), "# My Local Home\n", "Vault root untouched");
  assert.match(read(path.join(dst, "10-Global", "preferences.md")), /my own local pref/u, "10-Global untouched");
  assert.equal(read(path.join(dstLaya, "labels.jsonl")), "{\"prompt\":\"local only\"}\n", "Laya untouched");
  assert.ok(!fs.existsSync(path.join(dst, "00-System", "import-conflicts")), "no conflicts from excluded files");
  assert.deepEqual(parseProjectsYaml(read(path.join(dst, "00-System", "projects.yaml"))).map((p) => p.id), ["local-0", "alpha-1"]);

  // Repeatable --only-project + --with-global + --with-laya into a fresh target.
  const dst2 = path.join(base, "dst2");
  const dstLaya2 = path.join(base, "laya-dst2");
  const plan2 = await asDevice("DST2", async () =>
    planImport(await openBundleFile(bundleFile, { stagingDir: path.join(base, "st2") }), {
      targetVault: dst2, layaDir: dstLaya2, onlyProjects: ["alpha-1", "gamma-3"], withGlobal: true, includeLaya: true
    })
  );
  applyImport(plan2);
  assert.deepEqual(parseProjectsYaml(read(path.join(dst2, "00-System", "projects.yaml"))).map((p) => p.id).sort(), ["alpha-1", "gamma-3"]);
  assert.ok(fs.existsSync(path.join(dst2, "20-Projects", "alpha-1", "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(dst2, "20-Projects", "gamma-3", "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(dst2, "20-Projects", "beta-2")));
  assert.ok(fs.existsSync(path.join(dst2, "10-Global", "preferences.md")), "--with-global imported 10-Global");
  assert.ok(!fs.existsSync(path.join(dst2, "30-Shared", "shared.md")), "30-Shared still excluded in --only-project mode");
  assert.equal(read(path.join(dstLaya2, "labels.jsonl")), "{\"prompt\":\"from src\"}\n", "--with-laya imported Laya");
  fs.rmSync(base, { recursive: true, force: true });
});

test("--no-global skips 10-Global in normal mode; conflicting flags and unknown projects are rejected; transfer: local stays protected", async () => {
  const base = tmp("om-noglobal-");
  const src = makeVault(path.join(base, "src"), {
    projects: [{ id: "alpha-1", roots: [] }, { id: "secret-local", roots: [] }]
  });
  const bundleFile = path.join(base, "full.tar.gz");
  await asDevice("SRC", () => exportToFile(src, bundleFile, { layaDir: path.join(base, "l0") }));

  const dst = makeVault(path.join(base, "dst"), { projects: [{ id: "secret-local", roots: [] }] });
  write(path.join(dst, "10-Global", "preferences.md"), "local global stays\n");
  write(path.join(dst, "20-Projects", "secret-local", "wiki", "knowledge", "note.md"), "stay local\n");
  setLocalOnly(dst, "secret-local", true, { apply: true });

  // Conflicting CLI flags rejected.
  const err1 = sink();
  assert.equal(await importMain([bundleFile, "--vault", dst, "--only-project", "alpha-1", "--skip-project", "secret-local"], sink(), err1), 1);
  assert.match(err1.text, /--only-project and --skip-project cannot be used together/u);
  const err2 = sink();
  assert.equal(await importMain([bundleFile, "--vault", dst, "--no-global", "--with-global"], sink(), err2), 1);
  assert.match(err2.text, /--no-global and --with-global cannot be used together/u);
  const err3 = sink();
  assert.equal(await importMain([bundleFile, "--vault", dst, "--no-laya", "--with-laya"], sink(), err3), 1);
  assert.match(err3.text, /--no-laya and --with-laya cannot be used together/u);

  // Unknown project id rejected (not silent fake success).
  const err4 = sink();
  assert.equal(await importMain([bundleFile, "--vault", dst, "--only-project", "does-not-exist"], sink(), err4, { layaDir: path.join(base, "l1") }), 1);
  assert.match(err4.text, /project\(s\) not found in bundle: does-not-exist/u);
  assert.match(err4.text, /alpha-1/u);

  // transfer: local project stays protected even when explicitly passed to --only-project.
  const localPlan = planImport(fs.readFileSync(bundleFile), {
    targetVault: dst, layaDir: path.join(base, "l1"), onlyProjects: ["alpha-1", "secret-local"]
  });
  assert.deepEqual(localPlan.scope.onlyProjects, ["alpha-1"]);
  assert.deepEqual(localPlan.scope.localOnlySkipped, ["secret-local"]);
  assert.match(localPlan.warnings.join("\n"), /secret-local.*transfer: local/u);
  assert.ok(!localPlan.writes.some((w) => w.abs.includes("secret-local")));

  // --no-global in normal mode imports alpha-1 and root, skips 10-Global and protects secret-local.
  const out = sink();
  assert.equal(
    await asDevice("DST", () => importMain([bundleFile, "--vault", dst, "--no-global", "--yes"], out, sink(), { layaDir: path.join(base, "l1"), collectHosts: () => ({ hosts: [] }) })),
    0
  );
  assert.match(out.text, /Left out: 10-Global \(--no-global\)/u);
  assert.ok(fs.existsSync(path.join(dst, "20-Projects", "alpha-1", "wiki", "knowledge", "note.md")));
  assert.equal(read(path.join(dst, "10-Global", "preferences.md")), "local global stays\n");
  assert.equal(read(path.join(dst, "20-Projects", "secret-local", "wiki", "knowledge", "note.md")), "stay local\n");
  fs.rmSync(base, { recursive: true, force: true });
});

test("whitelist sync baseline safety: skipped projects and 10-Global are never marked deletedHere on a subsequent full import", () => {
  const base = tmp("om-wl-base-");
  const src = makeVault(path.join(base, "src"), {
    projects: [{ id: "alpha-1", roots: [] }, { id: "beta-2", roots: [] }]
  });
  const layaSrc = path.join(base, "laya-src");
  const layaDst = path.join(base, "laya-dst");
  const full = asDevice("SRC", () => buildExport(src, { layaDir: layaSrc }).bundle);

  // Step 1: DST imports ONLY alpha-1 into a fresh folder.
  const dst = path.join(base, "dst");
  asDevice("DST", () => {
    const p1 = planImport(full, { targetVault: dst, layaDir: layaDst, onlyProjects: ["alpha-1"] });
    applyImport(p1);
  });
  const syncedAfterWhitelist = readSynced(dst, { layaDir: layaDst, peer: "SRC" });
  assert.ok(Object.keys(syncedAfterWhitelist).every((rel) => rel.startsWith("20-Projects/alpha-1/")), "only alpha-1 paths recorded in sync baseline");

  // Step 2: DST later runs a full import of the same bundle.
  const fullPlan = asDevice("DST", () => planImport(full, { targetVault: dst, layaDir: layaDst }));
  assert.deepEqual(fullPlan.vault.deletedHere, [], "beta-2 and 10-Global must NOT be treated as deletedHere");
  assert.ok(fullPlan.vault.add.includes("20-Projects/beta-2/wiki/knowledge/note.md"), "beta-2 is added cleanly");
  assert.ok(fullPlan.vault.add.includes("10-Global/preferences.md"), "10-Global is added cleanly");
  applyImport(fullPlan);
  assert.ok(fs.existsSync(path.join(dst, "20-Projects", "beta-2", "wiki", "knowledge", "note.md")));
  assert.ok(fs.existsSync(path.join(dst, "10-Global", "preferences.md")));
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 2. Incremental export & import

test("incremental lifecycle: full -> edit/add small notes (3MB binary unchanged) -> tiny incremental bundle -> byte-exact sync -> empty second incremental", async () => {
  const base = tmp("om-inc-life-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1", roots: [] }] });
  const bigBin = crypto.randomBytes(3 * 1024 * 1024 + 37);
  write(path.join(A, "20-Projects", "app-1", "raw", "assets", "cand-1", "big.png"), bigBin);
  const lA = path.join(base, "laya-A");
  const lB = path.join(base, "laya-B");
  write(path.join(lA, "labels.jsonl"), "{\"p\":1}\n");

  // 1. Initial full export from A -> import to B.
  const fullFile = path.join(base, "full-a.tar.gz");
  const fullRes = await asDevice("A", () => exportToFile(A, fullFile, { layaDir: lA }));
  assert.equal(fullRes.manifest.formatVersion, FULL_BUNDLE_FORMAT_VERSION);
  assert.equal(fullRes.manifest.bundleType, "full");
  const B = path.join(base, "B");
  await asDevice("B", async () => {
    const opened = await openBundleFile(fullFile, { stagingDir: path.join(base, "st-full") });
    applyImport(planImport(opened, { targetVault: B, layaDir: lB }));
  });
  assert.ok(fs.readFileSync(path.join(B, "20-Projects/app-1/raw/assets/cand-1/big.png")).equals(bigBin));

  // 2. On B: edit 1 note, add 1 note, leave 3MB attachment untouched.
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: app-1\n---\n\nupdated on B\n");
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "fresh.md"), "---\ntitle: Fresh\n---\n\nnew on B\n");

  // 3. B exports incremental (auto-detects single peer A!).
  const incOut = sink();
  const incDir = path.join(base, "out-inc");
  fs.mkdirSync(incDir, { recursive: true });
  const now = new Date(2026, 10, 28, 12, 0, 0);
  assert.equal(
    await asDevice("B", () => exportMain(["--vault", B, "--out", incDir, "--incremental"], incOut, sink(), { layaDir: lB, now })),
    0
  );
  const incFile = path.join(incDir, "obsidian-memory-incremental-20261128-120000.tar.gz");
  assert.ok(fs.existsSync(incFile));
  assert.match(incOut.text, /incremental since device "A"/u);
  assert.match(incOut.text, /2 changed Vault file\(s\) packed/u);

  const fullSize = fs.statSync(fullFile).size;
  const incSize = fs.statSync(incFile).size;
  assert.ok(fullSize > 3 * 1024 * 1024, `full bundle > 3MB (${fullSize})`);
  assert.ok(incSize < 64 * 1024, `incremental bundle < 64KB (${incSize})`);

  const openedInc = await openBundleFile(incFile, { stagingDir: path.join(base, "st-inc") });
  assert.equal(openedInc.manifest.formatVersion, INCREMENTAL_BUNDLE_FORMAT_VERSION);
  assert.equal(openedInc.manifest.bundleType, "incremental");
  assert.equal(openedInc.manifest.incremental.baseKind, "device");
  assert.equal(openedInc.manifest.incremental.baseDevice, "A");
  assert.ok(openedInc.unchanged.some((u) => u.path.endsWith("big.png")), "3MB binary omitted as unchanged");
  assert.ok(!openedInc.entries.some((e) => e.path.endsWith("big.png")), "3MB binary not packed");

  // 4. A imports incremental bundle from B -> byte-exact match, no deletedThere, baseline updated.
  const impOut = sink();
  assert.equal(
    await asDevice("A", () => importMain([incFile, "--vault", A, "--yes"], impOut, sink(), { layaDir: lA, collectHosts: () => ({ hosts: [] }) })),
    0
  );
  assert.match(impOut.text, /Bundle: incremental \(since device "A"\)/u);
  assert.match(impOut.text, /unchanged \(omitted in incremental bundle\)/u);
  assert.equal(read(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md")));
  assert.equal(read(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "fresh.md")), read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "fresh.md")));
  assert.ok(fs.readFileSync(path.join(A, "20-Projects/app-1/raw/assets/cand-1/big.png")).equals(bigBin));
  const syncedA = readSynced(A, { layaDir: lA, peer: "B" });
  assert.ok(syncedA["20-Projects/app-1/raw/assets/cand-1/big.png"], "unchanged file kept in sync baseline");
  assert.ok(syncedA["20-Projects/app-1/wiki/knowledge/fresh.md"], "new file added to sync baseline");

  // 5. A immediately runs incremental export back to B -> 0 changed files!
  const emptyIncFile = path.join(base, "inc-empty.tar.gz");
  const emptyRes = await asDevice("A", () => exportToFile(A, emptyIncFile, { layaDir: lA, incremental: true }));
  assert.equal(emptyRes.bundleType, "incremental");
  assert.equal(emptyRes.manifest.incremental.changedCount, 0);
  assert.equal(emptyRes.manifest.files.length, 0, "zero changed files (including Laya)");
  const noopPlan = await asDevice("B", async () =>
    planImport(await openBundleFile(emptyIncFile, { stagingDir: path.join(base, "st-empty") }), { targetVault: B, layaDir: lB })
  );
  assert.equal(noopPlan.writes.length, 0);
  assert.deepEqual(noopPlan.vault.deletedThere, []);
  fs.rmSync(base, { recursive: true, force: true });
});

test("incremental fallback to full when no baseline or --full, plus --since <bundle> chaining and exporter-side deletion detection", async () => {
  const base = tmp("om-inc-since-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1", roots: [] }] });
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "remove-me.md"), "will be deleted on A\n");
  const lA = path.join(base, "laya-A");
  const lB = path.join(base, "laya-B");

  // No baseline yet -> --incremental falls back to full with clear explanation.
  const outFallback = sink();
  const f1 = path.join(base, "f1.tar.gz");
  assert.equal(await asDevice("A", () => exportMain(["--vault", A, "--out", f1, "--incremental"], outFallback, sink(), { layaDir: lA })), 0);
  assert.match(outFallback.text, /no sync baseline recorded.*exporting a full bundle/iu);
  assert.equal((await openBundleFile(f1)).manifest.bundleType, "full");

  // B imports f1.
  const B = path.join(base, "B");
  await asDevice("B", async () => applyImport(planImport(await openBundleFile(f1, { stagingDir: path.join(base, "s1") }), { targetVault: B, layaDir: lB })));

  // A edits note.md and deletes remove-me.md; A has never imported from B, so uses --since f1.tar.gz!
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "v2 on A\n");
  fs.rmSync(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "remove-me.md"));
  const inc1 = path.join(base, "inc1.tar.gz");
  const r1 = await asDevice("A", () => exportToFile(A, inc1, { layaDir: lA, since: f1 }));
  assert.equal(r1.bundleType, "incremental");
  assert.equal(r1.manifest.incremental.baseKind, "bundle");
  assert.equal(r1.manifest.incremental.changedCount, 1);

  // Chained incremental: A adds another file and exports --since inc1 (an incremental bundle!).
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "chain.md"), "chained\n");
  const inc2 = path.join(base, "inc2.tar.gz");
  const r2 = await asDevice("A", () => exportToFile(A, inc2, { layaDir: lA, since: inc1 }));
  assert.equal(r2.bundleType, "incremental");
  assert.deepEqual(r2.manifest.files.map((f) => f.path), ["vault/20-Projects/app-1/wiki/knowledge/chain.md"]);

  // B imports inc1: note.md fast-forwards, remove-me.md is distinguished as deletedThere (NOT unchanged),
  // unchanged files are NOT reported in deletedThere!
  const p1 = await asDevice("B", async () => planImport(await openBundleFile(inc1, { stagingDir: path.join(base, "s2") }), { targetVault: B, layaDir: lB }));
  assert.deepEqual(p1.vault.fastForward, ["20-Projects/app-1/wiki/knowledge/note.md"]);
  assert.deepEqual(p1.vault.deletedThere, ["20-Projects/app-1/wiki/knowledge/remove-me.md"]);
  assert.ok(p1.vault.unchanged.includes("Home.md"));
  assert.ok(!p1.vault.deletedThere.includes("Home.md"));
  applyImport(p1);

  // B then imports chained inc2 cleanly.
  const p2 = await asDevice("B", async () => planImport(await openBundleFile(inc2, { stagingDir: path.join(base, "s3") }), { targetVault: B, layaDir: lB }));
  assert.deepEqual(p2.vault.add, ["20-Projects/app-1/wiki/knowledge/chain.md"]);
  applyImport(p2);
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "chain.md")), "chained\n");

  // --full explicitly forces full export even when --since is passed.
  const forcedFull = asDevice("A", () => buildExport(A, { layaDir: lA, since: f1, full: true }));
  assert.equal(forcedFull.bundleType, "full");
  assert.match(forcedFull.fallbackReason, /--full/u);

  // --since with unknown device falls back to full; missing bundle file path errors.
  const unkDev = asDevice("A", () => buildExport(A, { layaDir: lA, since: "NeverSyncedPC" }));
  assert.equal(unkDev.bundleType, "full");
  assert.match(unkDev.fallbackReason, /no sync baseline for device "NeverSyncedPC"/u);
  assert.throws(() => asDevice("A", () => buildExport(A, { layaDir: lA, since: "/no/such/bundle.tar.gz" })), /baseline bundle not found/u);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 3. Incremental safety boundaries

test("incremental safety: rejects empty dir, missing unchanged file, mismatched content, wrong device, and tampered unchanged list", async () => {
  const base = tmp("om-inc-safe-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1", roots: [] }] });
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");
  const full = asDevice("A", () => buildExport(A, { layaDir: lA }).bundle);
  const B = path.join(base, "B");
  asDevice("B", () => applyImport(planImport(full, { targetVault: B, layaDir: lB })));

  // B edits one note and exports incremental targeting device "A".
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "updated on B\n");
  const incBtoA = asDevice("B", () => buildExport(B, { layaDir: lB, incremental: true }).bundle);

  // 1. Empty / missing directory -> rejected, guides to --full.
  const emptyDir = path.join(base, "empty");
  fs.mkdirSync(emptyDir);
  assert.throws(
    () => asDevice("A", () => planImport(incBtoA, { targetVault: emptyDir, layaDir: lA })),
    /cannot import an incremental bundle into an empty or missing folder.*omem export --full/u
  );
  assert.throws(
    () => asDevice("A", () => planImport(incBtoA, { targetVault: path.join(base, "missing"), layaDir: lA })),
    /cannot import an incremental bundle into an empty or missing folder.*omem export --full/u
  );

  // 2. Wrong target device ("C" tries to import bundle built for device "A") -> rejected.
  assert.throws(
    () => asDevice("C", () => planImport(incBtoA, { targetVault: A, layaDir: path.join(base, "lC") })),
    /built for device "A", not this machine \("C"\)/u
  );

  // 3. Target Vault missing an omitted unchanged file -> rejected, guides to --full.
  const missingFileVault = path.join(base, "A-missing");
  fs.cpSync(A, missingFileVault, { recursive: true });
  fs.rmSync(path.join(missingFileVault, "Home.md"));
  assert.throws(
    () => asDevice("A", () => planImport(incBtoA, { targetVault: missingFileVault, layaDir: lA })),
    /incremental bundle baseline mismatch.*Home\.md \(missing in target Vault\).*omem export --full/u
  );

  // 4. Target Vault has different content for an omitted unchanged file (no local sync record proving edit) -> rejected.
  const divergedVault = path.join(base, "A-diverged");
  fs.cpSync(A, divergedVault, { recursive: true });
  write(path.join(divergedVault, "Home.md"), "# Completely different Vault\n");
  assert.throws(
    () => asDevice("A", () => planImport(incBtoA, { targetVault: divergedVault, layaDir: path.join(base, "lFresh") })),
    /incremental bundle baseline mismatch.*Home\.md \(content differs from incremental baseline\).*omem export --full/u
  );

  // 5. Tampered manifest.unchanged (violating baseDigest) -> rejected at openBundle.
  const { files } = readTarGz(incBtoA);
  const tampered = createTarGz(files.map((f) => {
    if (f.name !== "manifest.json") return f;
    const m = JSON.parse(f.data.toString("utf8"));
    m.unchanged = m.unchanged.slice(1);
    return { ...f, data: Buffer.from(JSON.stringify(m)) };
  }));
  assert.throws(() => openBundle(tampered), /does not match baseDigest/u);

  // 6. Local legitimate edit on A (when A HAS ownRecord from prior sync with B) -> keptNewer, NOT rejected!
  // First sync A <- incBtoA so A has ownRecord for B.
  asDevice("A", () => applyImport(planImport(incBtoA, { targetVault: A, layaDir: lA })));
  // Now A edits Home.md locally; B edits AGENTS.md and exports incremental to A.
  write(path.join(A, "Home.md"), "# Home edited on A\n");
  write(path.join(B, "AGENTS.md"), "# Vault Root edited on B\n");
  const inc2 = asDevice("B", () => buildExport(B, { layaDir: lB, incremental: true }).bundle);
  const pKeep = asDevice("A", () => planImport(inc2, { targetVault: A, layaDir: lA }));
  assert.ok(pKeep.vault.keptNewer.includes("Home.md"), "A's local edit on an omitted file is keptNewer");
  assert.ok(pKeep.vault.fastForward.includes("AGENTS.md"), "B's edit fast-forwards cleanly");
  applyImport(pKeep);
  assert.equal(read(path.join(A, "Home.md")), "# Home edited on A\n");
  assert.equal(read(path.join(A, "AGENTS.md")), "# Vault Root edited on B\n");
  fs.rmSync(base, { recursive: true, force: true });
});

test("encrypted incremental bundle, incremental + --only-project / --no-global / transfer: local, and legacy v0.15 full bundle compatibility", async () => {
  const base = tmp("om-inc-combo-");
  const A = makeVault(path.join(base, "A"), {
    projects: [{ id: "app-1", roots: [] }, { id: "app-2", roots: [] }, { id: "priv-local", roots: [] }]
  });
  const lA = path.join(base, "lA");
  const lB = path.join(base, "lB");
  const passFile = path.join(base, "pass.txt");
  write(passFile, "super-secret-passphrase\n");

  // Full encrypted export from A.
  const fullEnc = path.join(base, "full.tar.gz.enc");
  assert.equal(await asDevice("A", () => exportMain(["--vault", A, "--out", fullEnc, "--encrypt", "--passphrase-file", passFile], sink(), sink(), { layaDir: lA })), 0);
  assert.ok(isEncrypted(fs.readFileSync(fullEnc)));

  // B imports full encrypted bundle, then marks priv-local as transfer: local and edits its 10-Global.
  const B = path.join(base, "B");
  assert.equal(
    await asDevice("B", () => importMain([fullEnc, "--vault", B, "--passphrase-file", passFile, "--yes"], sink(), sink(), { layaDir: lB, collectHosts: () => ({ hosts: [] }) })),
    0
  );
  setLocalOnly(B, "priv-local", true, { apply: true });
  write(path.join(B, "20-Projects", "priv-local", "wiki", "knowledge", "note.md"), "B local secret\n");

  // A modifies all 3 projects + 10-Global, then exports an encrypted incremental bundle --since fullEnc!
  write(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "app-1 v2\n");
  write(path.join(A, "20-Projects", "app-2", "wiki", "knowledge", "note.md"), "app-2 v2\n");
  write(path.join(A, "20-Projects", "priv-local", "wiki", "knowledge", "note.md"), "A changed priv-local\n");
  write(path.join(A, "10-Global", "preferences.md"), "A changed global\n");
  const incEnc = path.join(base, "inc.tar.gz.enc");
  assert.equal(
    await asDevice("A", () => exportMain(["--vault", A, "--out", incEnc, "--since", fullEnc, "--encrypt", "--passphrase-file", passFile], sink(), sink(), { layaDir: lA })),
    0
  );
  assert.ok(isEncrypted(fs.readFileSync(incEnc)));

  // B imports encrypted incremental bundle with --only-project app-1 (even if B deleted app-2!).
  fs.rmSync(path.join(B, "20-Projects", "app-2"), { recursive: true, force: true });
  assert.equal(
    await asDevice("B", () => importMain([incEnc, "--vault", B, "--passphrase-file", passFile, "--only-project", "app-1", "--yes"], sink(), sink(), { layaDir: lB, collectHosts: () => ({ hosts: [] }) })),
    0
  );
  assert.equal(read(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), "app-1 v2\n", "app-1 updated");
  assert.ok(!fs.existsSync(path.join(B, "20-Projects", "app-2")), "app-2 remained excluded and did not break baseline check");
  assert.equal(read(path.join(B, "20-Projects", "priv-local", "wiki", "knowledge", "note.md")), "B local secret\n", "transfer: local protected");
  assert.match(read(path.join(B, "10-Global", "preferences.md")), /pref from source/u, "10-Global untouched");

  // Backward compatibility: v0.15.0 full bundle (formatVersion 1, no bundleType field) imports cleanly.
  const rawFull = buildExport(A, { layaDir: lA }).bundle;
  const { files } = readTarGz(rawFull);
  const v015 = createTarGz(files.map((f) => {
    if (f.name !== "manifest.json") return f;
    const m = JSON.parse(f.data.toString("utf8"));
    delete m.bundleType;
    m.formatVersion = 1;
    return { ...f, data: Buffer.from(JSON.stringify(m)) };
  }));
  const legacyTarget = path.join(base, "legacy-dst");
  const legacyPlan = planImport(v015, { targetVault: legacyTarget, layaDir: path.join(base, "lLeg") });
  assert.equal(legacyPlan.bundleType, "full");
  applyImport(legacyPlan);
  assert.equal(read(path.join(legacyTarget, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), "app-1 v2\n");
  fs.rmSync(base, { recursive: true, force: true });
});

test("three-machine cross-sync with incremental bundles: no rollback, multi-peer requires --since, and CRLF streaming hash parity", () => {
  const base = tmp("om-inc-3m-");
  const L = (n) => path.join(base, `laya-${n}`);
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "app-1", roots: [] }] });
  const B = path.join(base, "B");
  const C = path.join(base, "C");

  // B and C start from A's full export.
  const aFull = asDevice("A", () => buildExport(A, { layaDir: L("A") }).bundle);
  asDevice("B", () => applyImport(planImport(aFull, { targetVault: B, layaDir: L("B"), includeLaya: false })));
  asDevice("C", () => applyImport(planImport(aFull, { targetVault: C, layaDir: L("C"), includeLaya: false })));

  // A edits Home.md to v2, B imports full from A and syncs back incrementally to A.
  write(path.join(A, "Home.md"), "# Home v2 (A)\n");
  const aFull2 = asDevice("A", () => buildExport(A, { layaDir: L("A") }).bundle);
  asDevice("B", () => applyImport(planImport(aFull2, { targetVault: B, layaDir: L("B"), includeLaya: false })));
  write(path.join(B, "20-Projects", "app-1", "wiki", "knowledge", "from-b.md"), "from B\n");
  const bInc = asDevice("B", () => buildExport(B, { layaDir: L("B"), incremental: true }).bundle);
  asDevice("A", () => applyImport(planImport(bInc, { targetVault: A, layaDir: L("A"), includeLaya: false })));
  assert.equal(read(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "from-b.md")), "from B\n");

  // C (still on Home v1) adds from-c.md and exports incremental targeting A (C's only peer).
  write(path.join(C, "20-Projects", "app-1", "wiki", "knowledge", "from-c.md"), "from C\n");
  const cInc = asDevice("C", () => buildExport(C, { layaDir: L("C"), incremental: true }).bundle);
  // A has never synced with C and Home.md is v2 on A (v1 in C's unchanged) -> A safely rejects instead of rolling back!
  assert.throws(
    () => asDevice("A", () => planImport(cInc, { targetVault: A, layaDir: L("A"), includeLaya: false })),
    /incremental bundle baseline mismatch.*Home\.md/u
  );
  assert.equal(read(path.join(A, "Home.md")), "# Home v2 (A)\n", "no rollback");

  // C exports full -> A imports full (keeps Home v2, takes from-c.md, records peer C!).
  const cFull = asDevice("C", () => buildExport(C, { layaDir: L("C"), full: true }).bundle);
  const pAC = asDevice("A", () => planImport(cFull, { targetVault: A, layaDir: L("A"), includeLaya: false }));
  assert.ok(pAC.vault.keptNewer.includes("Home.md"));
  assert.ok(pAC.vault.add.includes("20-Projects/app-1/wiki/knowledge/from-c.md"));
  applyImport(pAC);
  assert.equal(read(path.join(A, "Home.md")), "# Home v2 (A)\n");

  // Now A has 2 peers (B and C): --incremental without --since must ask for --since <device>.
  assert.throws(
    () => asDevice("A", () => buildExport(A, { layaDir: L("A"), incremental: true })),
    /multiple synced devices found \(B, C\); pass --since <device>/u
  );

  // Now C edits from-c.md to v2 and sends incremental to A -> A keeps Home v2 (via ownRecord for C) and fast-forwards from-c.md!
  write(path.join(C, "20-Projects", "app-1", "wiki", "knowledge", "from-c.md"), "from C v2\n");
  const cInc2 = asDevice("C", () => buildExport(C, { layaDir: L("C"), incremental: true }).bundle);
  const pAC2 = asDevice("A", () => planImport(cInc2, { targetVault: A, layaDir: L("A"), includeLaya: false }));
  assert.ok(pAC2.vault.keptNewer.includes("Home.md"), "A keeps Home v2");
  assert.ok(pAC2.vault.fastForward.includes("20-Projects/app-1/wiki/knowledge/from-c.md"));
  applyImport(pAC2);
  assert.equal(read(path.join(A, "Home.md")), "# Home v2 (A)\n");
  assert.equal(read(path.join(A, "20-Projects", "app-1", "wiki", "knowledge", "from-c.md")), "from C v2\n");

  // Streaming CRLF-normalized hash matches syncHash even across 1 MiB chunk boundaries.
  const crlfFile = path.join(base, "big-crlf.md");
  const bigText = "a".repeat(1024 * 1024 - 1) + "\r\nsecond line\rthird line\n";
  write(crlfFile, bigText);
  assert.equal(hashTextFileNormalizedSync(crlfFile), syncHash("big-crlf.md", bigText));
  assert.equal(BUNDLE_FORMAT_VERSION, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

test("whitelist fold-ledger anti-pollution and incremental changed-file conflict parking", async () => {
  const { textHash, LEDGER_REL } = await import("../lib/vault-transfer/reconcile.js");
  const base = tmp("om-wl-fold-");
  const A = makeVault(path.join(base, "A"), { projects: [{ id: "alpha-1", roots: [] }, { id: "beta-2", roots: [] }] });
  const B = makeVault(path.join(base, "B"), { projects: [{ id: "alpha-1", roots: [] }, { id: "beta-2", roots: [] }] });
  // A has a fold ledger entry deleting beta-2's note, folded into another page.
  const betaText = read(path.join(B, "20-Projects", "beta-2", "wiki", "knowledge", "note.md"));
  write(path.join(A, "20-Projects", "beta-2", "wiki", "knowledge", "target.md"), "# Target\n");
  write(path.join(A, LEDGER_REL), JSON.stringify({
    folded: "20-Projects/beta-2/wiki/knowledge/note.md",
    hash: textHash(betaText),
    into: "20-Projects/beta-2/wiki/knowledge/target.md",
    at: "2026-11-28T00:00:00Z",
    device: "A"
  }) + "\n");
  const fullA = asDevice("A", () => buildExport(A, { layaDir: path.join(base, "lA") }).bundle);

  // B imports with --only-project alpha-1 -> beta-2's fold MUST NOT remove B's beta-2 note!
  const p = asDevice("B", () => planImport(fullA, { targetVault: B, layaDir: path.join(base, "lB"), onlyProjects: ["alpha-1"] }));
  assert.deepEqual(p.ingest.removedFolded, []);
  applyImport(p);
  assert.ok(fs.existsSync(path.join(B, "20-Projects", "beta-2", "wiki", "knowledge", "note.md")), "out-of-scope beta-2 note not removed by fold ledger");

  // Incremental conflict parking: both A and B edit the same file after baseline sync.
  const lA2 = path.join(base, "lA2");
  const lB2 = path.join(base, "lB2");
  const C = makeVault(path.join(base, "C"), { projects: [{ id: "app-1", roots: [] }] });
  const D = path.join(base, "D");
  const cFull = asDevice("C", () => buildExport(C, { layaDir: lA2 }).bundle);
  asDevice("D", () => applyImport(planImport(cFull, { targetVault: D, layaDir: lB2, includeLaya: false })));
  write(path.join(C, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "edited on C\n");
  write(path.join(D, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "edited on D\n");
  const dInc = asDevice("D", () => buildExport(D, { layaDir: lB2, incremental: true, withLaya: false }).bundle);
  const conflictPlan = asDevice("C", () => planImport(dInc, { targetVault: C, layaDir: lA2, includeLaya: false }));
  assert.deepEqual(conflictPlan.vault.conflicts.map((c) => c.rel), ["20-Projects/app-1/wiki/knowledge/note.md"]);
  applyImport(conflictPlan);
  assert.equal(read(path.join(C, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), "edited on C\n", "local kept");
  assert.equal(read(path.join(C, conflictPlan.vault.conflicts[0].copy)), "edited on D\n", "incoming parked in conflicts dir");
  fs.rmSync(base, { recursive: true, force: true });
});
