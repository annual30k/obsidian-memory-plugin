// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTarGz, sha256 } from "../lib/vault-transfer/archive.js";
import { buildExport, exportToFile } from "../lib/vault-transfer/export.js";
import { applyImport, openBundle, openBundleFile, planImport } from "../lib/vault-transfer/import.js";
import { hashFileSync, readBundleFile, writeBundleFile } from "../lib/vault-transfer/stream.js";

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

function vault(root) {
  write(path.join(root, "00-System", "projects.yaml"), "projects:\n  - id: app-1\n    roots: []\n    scope: private\n");
  write(path.join(root, "AGENTS.md"), "# Vault\n");
  write(path.join(root, "20-Projects", "app-1", "wiki", "knowledge", `${"很长的中文名字".repeat(12)}.md`), "---\ntitle: 长\n---\n\n正文\n");
  write(path.join(root, "20-Projects", "app-1", "raw", "assets", "cand-x", "shot.png"), crypto.randomBytes(3 * 1024 * 1024 + 17));
  fs.mkdirSync(path.join(root, "20-Projects", "app-1", "checkpoints"), { recursive: true });
  return root;
}

test("streamed bundles and in-memory bundles are the same format, encrypted or not", async () => {
  const base = tmp("om-stream-");
  const v = vault(path.join(base, "v"));
  for (const passphrase of [null, "a long passphrase"]) {
    const file = path.join(base, `b-${passphrase ? "enc" : "plain"}.tar.gz`);
    const r = await exportToFile(v, file, { layaDir: path.join(base, "none"), passphrase });
    assert.equal(r.bytes, fs.statSync(file).size);
    // Streamed file -> in-memory reader.
    const mem = openBundle(fs.readFileSync(file), { passphrase });
    assert.equal(mem.entries.length, r.manifest.files.length);
    assert.ok(mem.dirs.includes("20-Projects/app-1/checkpoints"));
    // In-memory bundle -> streaming reader.
    const inMemFile = path.join(base, `m-${passphrase ? "enc" : "plain"}.tar.gz`);
    fs.writeFileSync(inMemFile, buildExport(v, { layaDir: path.join(base, "none"), passphrase }).bundle);
    const staged = path.join(base, `stage-${passphrase ? "e" : "p"}`);
    const opened = await openBundleFile(inMemFile, { passphrase, stagingDir: staged });
    const png = opened.entries.find((e) => e.path.endsWith("shot.png"));
    assert.equal(png.sha256, hashFileSync(path.join(v, "20-Projects", "app-1", "raw", "assets", "cand-x", "shot.png")));
    assert.ok(fs.statSync(png.file).size > 3 * 1024 * 1024, "binaries are staged on disk");
  }
  await assert.rejects(openBundleFile(path.join(base, "b-enc.tar.gz"), { passphrase: "not the passphrase" }), /wrong passphrase/u);
  await assert.rejects(openBundleFile(path.join(base, "b-enc.tar.gz")), /passphrase is required/u);
  fs.rmSync(base, { recursive: true, force: true });
});

test("a streamed import copies attachments file to file and reproduces the Vault", async () => {
  const base = tmp("om-stream-imp-");
  const v = vault(path.join(base, "v"));
  const file = path.join(base, "b.tar.gz");
  await exportToFile(v, file, { layaDir: path.join(base, "none") });
  const target = path.join(base, "t");
  const opened = await openBundleFile(file, { stagingDir: path.join(base, "stage") });
  const plan = planImport(opened, { targetVault: target, layaDir: path.join(base, "none") });
  const png = plan.writes.find((w) => w.abs.endsWith("shot.png"));
  assert.ok(png.from && !png.data, "the attachment is copied, not loaded");
  applyImport(plan);
  for (const rel of ["AGENTS.md", "20-Projects/app-1/raw/assets/cand-x/shot.png"]) {
    assert.ok(fs.readFileSync(path.join(v, rel)).equals(fs.readFileSync(path.join(target, rel))), rel);
  }
  // A changed attachment on both sides is parked as a conflict copy, also without loading it.
  fs.writeFileSync(path.join(target, "20-Projects/app-1/raw/assets/cand-x/shot.png"), crypto.randomBytes(1024));
  fs.writeFileSync(path.join(v, "20-Projects/app-1/raw/assets/cand-x/shot.png"), crypto.randomBytes(2048));
  const file2 = path.join(base, "b2.tar.gz");
  await exportToFile(v, file2, { layaDir: path.join(base, "none2") });
  const again = planImport(await openBundleFile(file2, { stagingDir: path.join(base, "stage2") }), { targetVault: target, layaDir: path.join(base, "none") });
  assert.deepEqual(again.vault.conflicts.map((c) => c.rel), ["20-Projects/app-1/raw/assets/cand-x/shot.png"]);
  assert.ok(again.writes.find((w) => w.abs.includes("import-conflicts")).from);
  fs.rmSync(base, { recursive: true, force: true });
});

test("streaming refuses damaged bundles, unsafe names, and files that change during an export", async () => {
  const base = tmp("om-stream-bad-");
  const v = vault(path.join(base, "v"));
  const good = buildExport(v, { layaDir: path.join(base, "none") }).bundle;
  // Tampered member.
  const tampered = path.join(base, "tampered.tar.gz");
  const { files } = (await import("../lib/vault-transfer/archive.js")).readTarGz(good);
  fs.writeFileSync(tampered, createTarGz(files.map((f) => (f.name === "vault/AGENTS.md" ? { ...f, data: Buffer.from("changed") } : f))));
  await assert.rejects(openBundleFile(tampered), /does not match its checksum/u);
  // Truncated gzip.
  const truncated = path.join(base, "truncated.tar.gz");
  fs.writeFileSync(truncated, good.subarray(0, Math.floor(good.length / 2)));
  await assert.rejects(openBundleFile(truncated));
  // An item whose content no longer matches its hash.
  await assert.rejects(writeBundleFile(path.join(base, "x.tar.gz"), [{ name: "vault/a.md", abs: path.join(v, "AGENTS.md"), size: 8, sha256: sha256(Buffer.from("other!!!")) }]), /changed while it was being exported/u);
  assert.ok(!fs.existsSync(path.join(base, "x.tar.gz")), "no half-written bundle");
  await assert.rejects(writeBundleFile(path.join(base, "y.tar.gz"), [{ name: "../escape", data: Buffer.from("x") }]), /cannot archive/u);
  const { members, rejected } = await readBundleFile(await (async () => {
    const f = path.join(base, "evil.tar.gz");
    fs.writeFileSync(f, createTarGz([{ name: "manifest.json", data: Buffer.from("{}") }]));
    return f;
  })());
  assert.ok(members.has("manifest.json"));
  assert.deepEqual(rejected, []);
  fs.rmSync(base, { recursive: true, force: true });
});
