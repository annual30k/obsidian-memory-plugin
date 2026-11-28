// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FREEZE_FORMAT, completeCandidates, freezeCandidates, readCandidate } from "../lib/vault-ingest.js";
import { buildExport } from "../lib/vault-transfer/export.js";
import { applyImport, mergeLog, planImport } from "../lib/vault-transfer/import.js";
import { reconcileCandidate, reconcileRaw } from "../lib/vault-transfer/reconcile.js";
import { main as ingestMain } from "../scripts/ingest-vault.mjs";
import { main as reconcileMain, parkedPages } from "../scripts/reconcile-vault.mjs";

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = (f) => fs.readFileSync(f, "utf8");
const sink = () => { let s = ""; return { write: (x) => { s += x; }, get text() { return s; } }; };
const P = "app-11111111";
const ids = ["cand-00000000-0000-4000-8000-000000000001", "cand-00000000-0000-4000-8000-000000000002", "cand-00000000-0000-4000-8000-000000000003", "cand-00000000-0000-4000-8000-000000000004"];

function candidate(id, { title = `标题 ${id.slice(-1)}`, extra = "" } = {}) {
  return `---\nschema_version: 1\nid: "${id}"\ntitle: "${title}"\ntype: memory-candidate\nscope: "project"\nproject_id: "${P}"\nstatus: pending-ingest\ncreated: "2026-11-20T10:00:00.000Z"\nsensitivity: internal\nsource_ref: "codex session s1"\nraw_record: null\nattachments: []\n${extra}---\n\n# ${title}\n\n## Original evidence\n\n> 用户说：发布前先跑测试。\n\n## Capture context and reason to retain\n\n长期约定。\n\n## Related canonical notes\n\n- None found automatically.\n`;
}

function vault(root) {
  write(path.join(root, "00-System", "projects.yaml"), `projects:\n  - id: ${P}\n    roots: []\n    scope: private\n`);
  write(path.join(root, "AGENTS.md"), "# Vault\n");
  write(path.join(root, "10-Global", "log.md"), "# Global log\n");
  const dir = path.join(root, "20-Projects", P);
  write(path.join(dir, "log.md"), "# Log\n");
  write(path.join(dir, "index.md"), "# Index\n");
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  fs.mkdirSync(path.join(dir, "wiki", "knowledge"), { recursive: true });
  for (const id of ids) write(path.join(dir, "inbox", `${id}.md`), candidate(id));
  return root;
}

/** What an agent does between freeze and complete: a page, a log entry, an index line. */
function synthesize(root, device, list) {
  process.env.OBSIDIAN_MEMORY_DEVICE = device;
  assert.ok(freezeCandidates(root, list, { apply: true }).every((r) => r.state === "frozen"));
  const dir = path.join(root, "20-Projects", P);
  for (const id of list) {
    const page = `wiki/knowledge/${device}-${id}.md`;
    write(path.join(dir, page), `---\ntitle: "${device}"\nsources:\n  - "[[20-Projects/${P}/raw/raw-${id}]]"\n---\n\n${device} wrote this.\n`);
    fs.appendFileSync(path.join(dir, "log.md"), `\n## [2026-11-28] ingest | ${id} on ${device}\n\ningest_id: ingest-${id}\ningested_on: ${device}\n`);
    fs.appendFileSync(path.join(dir, "index.md"), `- [[20-Projects/${P}/${page.replace(/\.md$/u, "")}]]\n`);
  }
  assert.ok(completeCandidates(root, list, { apply: true }).every((r) => r.state === "completed"));
  delete process.env.OBSIDIAN_MEMORY_DEVICE;
}

test("freeze is a pure function of the candidate: the same bytes on any machine, evidence verbatim", () => {
  const base = tmp("om-ingest-");
  const a = vault(path.join(base, "a"));
  const b = vault(path.join(base, "b"));
  process.env.OBSIDIAN_MEMORY_DEVICE = "mac";
  freezeCandidates(a, [ids[0]], { apply: true });
  process.env.OBSIDIAN_MEMORY_DEVICE = "win";
  freezeCandidates(b, [ids[0]], { apply: true });
  delete process.env.OBSIDIAN_MEMORY_DEVICE;
  const rel = path.join("20-Projects", P, "raw", `raw-${ids[0]}.md`);
  assert.ok(fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel))));
  const raw = read(path.join(a, rel));
  assert.match(raw, /^created: "2026-11-20T10:00:00\.000Z"$/mu);
  assert.match(raw, /^captured_at: "2026-11-20T10:00:00\.000Z"$/mu);
  assert.match(raw, new RegExp(`^frozen_by: ${FREEZE_FORMAT}$`, "mu"));
  assert.match(raw, /> 用户说：发布前先跑测试。/u);
  assert.doesNotMatch(raw, /Related canonical notes/u, "links to derived notes are not evidence");
  assert.equal(raw.match(/## Source reference/gu).length, 1);
  // A second run is a no-op; a hand-written Raw at that path is never overwritten.
  assert.equal(freezeCandidates(a, [ids[0]], { apply: true })[0].state, "already");
  write(path.join(a, "20-Projects", P, "raw", `raw-${ids[1]}.md`), "---\nid: hand\n---\n");
  const blocked = freezeCandidates(a, [ids[1]], { apply: true })[0];
  assert.equal(blocked.state, "blocked");
  assert.equal(read(path.join(a, "20-Projects", P, "raw", `raw-${ids[1]}.md`)), "---\nid: hand\n---\n");
  fs.rmSync(base, { recursive: true, force: true });
});

test("freeze refuses non-standard candidates and copies attachments byte for byte", () => {
  const base = tmp("om-ingest-refuse-");
  const v = vault(path.join(base, "v"));
  const inbox = path.join(v, "20-Projects", P, "inbox");
  write(path.join(inbox, ids[1] + ".md"), candidate(ids[1]).replace(`id: "${ids[1]}"`, `id: "${ids[2]}"`));
  write(path.join(inbox, ids[2] + ".md"), candidate(ids[2]).replace("sensitivity: internal\n", ""));
  write(path.join(inbox, ids[3] + ".md"), candidate(ids[3]).replace("长期约定。", "token: ghp_123456789012345678901234567890123456"));
  const r = freezeCandidates(v, [ids[1], ids[2], ids[3]]);
  assert.match(r[0].error, /does not match the file name/u);
  assert.match(r[1].error, /no sensitivity/u);
  assert.match(r[2].error, /credential/u);
  assert.ok(r.every((x) => x.state === "refused"));

  const att = `20-Projects/${P}/inbox/assets/${ids[0]}/shot.png`;
  write(path.join(v, ...att.split("/")), Buffer.from([1, 2, 3]));
  write(path.join(inbox, ids[0] + ".md"), candidate(ids[0]).replace("attachments: []\n", `attachments:\n  - "[[${att}]]"\n`).replace("长期约定。", `见 ![[${att}]]`));
  const [f] = freezeCandidates(v, [ids[0]], { apply: true });
  assert.equal(f.state, "frozen");
  const frozen = path.join(v, "20-Projects", P, "raw", "assets", ids[0], "shot.png");
  assert.deepEqual([...fs.readFileSync(frozen)], [1, 2, 3]);
  const raw = read(path.join(v, "20-Projects", P, "raw", `raw-${ids[0]}.md`));
  assert.match(raw, new RegExp(`- "\\[\\[20-Projects/${P}/raw/assets/${ids[0]}/shot\\.png\\]\\]"`, "u"));
  assert.match(raw, new RegExp(`!\\[\\[20-Projects/${P}/raw/assets/${ids[0]}/shot\\.png\\]\\]`, "u"));
  fs.writeFileSync(frozen, Buffer.from([9]));
  fs.rmSync(path.join(v, "20-Projects", P, "raw", `raw-${ids[0]}.md`));
  assert.match(freezeCandidates(v, [ids[0]])[0].error, /frozen attachment differs/u);
  fs.rmSync(base, { recursive: true, force: true });
});

test("complete needs the frozen Raw and the log marker, then marks the candidate the same way everywhere", () => {
  const base = tmp("om-ingest-complete-");
  const v = vault(path.join(base, "v"));
  assert.match(completeCandidates(v, [ids[0]])[0].error, /does not exist; run omem ingest freeze/u);
  freezeCandidates(v, [ids[0]], { apply: true });
  assert.match(completeCandidates(v, [ids[0]])[0].error, /no "ingest_id: ingest-/u);
  fs.appendFileSync(path.join(v, "20-Projects", P, "log.md"), `\n## [2026-11-28] ingest | x\n\ningest_id: ingest-${ids[0]}\n`);
  const [c] = completeCandidates(v, [ids[0]], { apply: true });
  assert.equal(c.state, "completed");
  assert.deepEqual(c.citedBy, []);
  const text = read(path.join(v, "20-Projects", P, "inbox", `${ids[0]}.md`));
  assert.match(text, /^status: ingested$/mu);
  assert.match(text, new RegExp(`^raw_record: "\\[\\[20-Projects/${P}/raw/raw-${ids[0]}\\]\\]"$`, "mu"));
  assert.equal(completeCandidates(v, [ids[0]], { apply: true })[0].state, "already");
  assert.equal(readCandidate(v, ids[0]).ok, true);

  const out = sink();
  assert.equal(ingestMain(["status", ids[0], "--vault", v], out, sink()), 0);
  assert.match(out.text, /status ingested; Raw frozen by omem; log marker present/u);
  const fr = sink();
  assert.equal(ingestMain(["freeze", ids[1], "--vault", v], fr, sink()), 0);
  assert.match(fr.text, /would be frozen[\s\S]*ingest_id: ingest-<candidate-id>[\s\S]*Dry run/u);
  fs.rmSync(base, { recursive: true, force: true });
});

test("both machines ingest overlapping candidates; imports reconcile by id and the two Vaults converge", () => {
  const base = tmp("om-converge-");
  const A = vault(path.join(base, "A"));
  synthesize(A, "mac", [ids[0], ids[1], ids[2]]);
  const B = path.join(base, "B");
  fs.cpSync(vault(path.join(base, "seedB")), B, { recursive: true });
  synthesize(B, "win", [ids[0], ids[1], ids[3]]);
  const none = path.join(base, "none");
  const send = (from, to) => {
    const plan = planImport(buildExport(from, { layaDir: none }).bundle, { targetVault: to, layaDir: none });
    applyImport(plan);
    return plan;
  };

  const first = send(A, B);
  assert.deepEqual(first.vault.conflicts, [], "no plain file conflicts");
  assert.equal(first.ingest.logEntriesSkipped, 2, "one ingest entry per candidate");
  assert.deepEqual(first.ingest.candidatesAdvanced, [`20-Projects/${P}/inbox/${ids[2]}.md`], "ingested only on A");
  assert.deepEqual(first.ingest.duplicates.map((d) => d.rel).sort(), [ids[0], ids[1]].map((id) => `20-Projects/${P}/wiki/knowledge/mac-${id}.md`));
  assert.ok(first.vault.add.includes(`20-Projects/${P}/wiki/knowledge/mac-${ids[2]}.md`));
  assert.match(read(path.join(B, "20-Projects", P, "index.md")), new RegExp(`Added by import[\\s\\S]*mac-${ids[2]}`, "u"));
  const logB = read(path.join(B, "20-Projects", P, "log.md"));
  for (const id of ids) assert.equal(logB.match(new RegExp(`ingest_id: ingest-${id}`, "gu")).length, 1, id);

  // The agent on B folds each parked page into its own page and records it.
  for (const p of parkedPages(B)) {
    fs.appendFileSync(path.join(B, p.localPages[0]), "\nFolded.\n");
    assert.equal(reconcileMain(["fold", p.copy, "--into", p.localPages[0], "--vault", B, "--yes"], sink(), sink()), 0);
  }
  assert.deepEqual(parkedPages(B), []);
  assert.equal(reconcileMain(["fold", `20-Projects/${P}/index.md`, "--into", `20-Projects/${P}/index.md`, "--vault", B, "--yes"], sink(), sink()), 1, "only parked pages");
  fs.rmSync(path.join(B, "00-System", "import-conflicts"), { recursive: true, force: true });

  // Re-importing A's same bundle into B parks nothing again.
  assert.equal(planImport(buildExport(A, { layaDir: none }).bundle, { targetVault: B, layaDir: none }).ingest.alreadyFolded.length, 2);

  const back = send(B, A);
  assert.deepEqual(back.ingest.removedFolded.map((r) => r.rel).sort(), [ids[0], ids[1]].map((id) => `20-Projects/${P}/wiki/knowledge/mac-${id}.md`));
  assert.ok(!fs.existsSync(path.join(A, "20-Projects", P, "wiki", "knowledge", `mac-${ids[0]}.md`)));
  assert.match(read(path.join(A, "20-Projects", P, "wiki", "knowledge", `win-${ids[0]}.md`)), /Folded\./u);
  assert.match(read(path.join(A, "20-Projects", P, "log.md")), /maintenance \| pages folded on another machine[\s\S]*on [^;]+; removed here by import/u);
  assert.doesNotMatch(read(path.join(A, "20-Projects", P, "index.md")), new RegExp(`mac-${ids[0]}`, "u"));

  send(A, B);
  for (const [from, to] of [[B, A], [A, B]]) {
    const again = planImport(buildExport(from, { layaDir: none }).bundle, { targetVault: to, layaDir: none });
    assert.equal(again.writes.length + again.removes.length, 0, "converged: nothing left to exchange");
  }
  const pages = (root) => fs.readdirSync(path.join(root, "20-Projects", P, "wiki", "knowledge")).sort();
  assert.deepEqual(pages(A), pages(B));
  for (const f of pages(A)) assert.equal(read(path.join(A, "20-Projects", P, "wiki", "knowledge", f)), read(path.join(B, "20-Projects", P, "wiki", "knowledge", f)), f);
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconcile rules: hand-frozen Raw compared by evidence, candidates by evidence then status, logs by marker", () => {
  const raw = (created, body) => `---\nid: raw-x\ncandidate_id: cand-x\ncreated: "${created}"\nstatus: frozen\n---\n\n${body}\n`;
  assert.equal(reconcileRaw(raw("2026-11-23T17:00:00+08:00", "evidence"), raw("2026-11-24T09:00:00Z", "evidence\n")), "same");
  assert.equal(reconcileRaw(raw("2026-11-23", "evidence"), raw("2026-11-23", "other evidence")), "conflict");
  const cand = (status, body = "e") => `---\nid: cand-x\nstatus: ${status}\nraw_record: ${status === "ingested" ? "\"[[r]]\"" : "null"}\n---\n\n${body}\n`;
  assert.equal(reconcileCandidate(cand("pending-ingest"), cand("ingested")), "incoming");
  assert.equal(reconcileCandidate(cand("ingested"), cand("pending-ingest")), "same");
  assert.equal(reconcileCandidate(cand("pending-ingest"), cand("pending-ingest", "edited")), "conflict");
  const local = "# Log\n\n## [2026-11-28] ingest | a on win\n\ningest_id: ingest-cand-a\n";
  const incoming = "# Log\n\n## [2026-11-28] ingest | a on mac\n\ningest_id: ingest-cand-a\n\n## [2026-11-28] ingest | b\n\ningest_id: ingest-cand-b\n";
  const m = mergeLog(local, incoming);
  assert.equal(m.added, 1);
  assert.equal(m.skipped, 1);
  assert.doesNotMatch(m.text, /a on mac/u);
});
