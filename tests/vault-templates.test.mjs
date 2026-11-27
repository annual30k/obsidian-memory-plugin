// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REQUIRED_FIELDS, TEMPLATE_NAMES, bundledTemplate, classifyTemplate, templateHash, templateNotice, templateStatus, updateTemplates
} from "../lib/vault-templates.js";
import { buildExport } from "../lib/vault-transfer/export.js";
import { applyImport, planImport } from "../lib/vault-transfer/import.js";
import { candidateTemplate, renderCandidate } from "../lib/memory-router/digest.js";
import { checkVault } from "../scripts/check-vault.mjs";
import { main as templatesMain } from "../scripts/templates-vault.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, "utf8");
const sink = () => { let s = ""; return { write: (x) => { s += x; }, get text() { return s; } }; };
const tpl = (vault, name) => path.join(vault, "00-System", "templates", name);
const crlf = (t) => t.replace(/\n/gu, "\r\n");
// decision.md before 0.10.0: the same file without `deprecated: false`.
const OLD_DECISION = bundledTemplate("decision.md").replace("deprecated: false\n", "");
// What an agent wrote on a real Windows machine instead of copying the templates.
const HANDWRITTEN = "---\ntype: decision\nstatus: accepted\ncreated: {{date}}\nproject_id: {{project_id}}\nraw_links: []\ntags: []\n---\n\n# Decision: {{title}}\n\n## Context & Problem Statement\n";

function vaultWith(files = {}) {
  const v = tmp("om-tpl-");
  write(path.join(v, "00-System", "projects.yaml"), "projects: []\n");
  for (const name of TEMPLATE_NAMES) write(tpl(v, name), bundledTemplate(name));
  for (const [name, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(tpl(v, name));
    else write(tpl(v, name), text);
  }
  return v;
}

test("every shipped template is in the fingerprint table (run `npm run templates:hashes` after editing one)", async () => {
  const table = JSON.parse(read(new URL("../lib/template-hashes.json", import.meta.url)));
  for (const name of TEMPLATE_NAMES) {
    assert.ok(table[name]?.[templateHash(bundledTemplate(name))]?.length, `${name}: edited without rebuilding the table`);
    assert.ok(fs.existsSync(new URL(`../skills/obsidian-memory/assets/templates/${name}`, import.meta.url)), name);
  }
  assert.deepEqual(fs.readdirSync(new URL("../skills/obsidian-memory/assets/templates/", import.meta.url)).filter((n) => n.endsWith(".md")).sort(), [...TEMPLATE_NAMES].sort());
  // Each shipped template carries the fields it requires of others.
  for (const name of TEMPLATE_NAMES) assert.equal(classifyTemplate(name, bundledTemplate(name)).state, "current");
  for (const [name, fields] of Object.entries(REQUIRED_FIELDS)) {
    for (const f of fields) assert.match(bundledTemplate(name), new RegExp(`^${f}:`, "mu"), `${name} has ${f}`);
  }
});

test("templates are classified by content: CRLF is current, an unedited old one is outdated, edits are custom or incompatible", () => {
  assert.equal(classifyTemplate("decision.md", crlf(bundledTemplate("decision.md"))).state, "current");
  const old = classifyTemplate("decision.md", OLD_DECISION);
  assert.equal(old.state, "outdated");
  assert.ok(old.versions.includes("0.9.1"));
  assert.equal(classifyTemplate("decision.md", bundledTemplate("decision.md") + "\n## My extra section\n").state, "custom");
  const hand = classifyTemplate("decision.md", HANDWRITTEN);
  assert.equal(hand.state, "incompatible");
  assert.deepEqual(hand.missingFields, ["title", "scope", "deprecated", "last_updated", "sensitivity", "sources"]);
  assert.equal(hand.problems.length, 2, "created: {{date}} and project_id: {{project_id}} are YAML objects");
  assert.equal(classifyTemplate("decision.md", "# no frontmatter\n").state, "incompatible");
  assert.equal(classifyTemplate("decision.md", null).state, "missing");
});

test("omem templates: status, install only adds, update upgrades unedited ones and replaces custom ones only when asked (with a backup)", () => {
  const v = vaultWith({ "decision.md": OLD_DECISION, "pitfall.md": HANDWRITTEN, "project-rules.md": bundledTemplate("project-rules.md") + "extra\n", "global-log.md": null });
  const out = sink();
  assert.equal(templatesMain(["--vault", v], out, sink()), 0);
  assert.match(out.text, /decision\.md\s+older plugin version, never edited \(0\.4\.0–0\.9\.1\)/u);
  assert.match(out.text, /pitfall\.md\s+edited or hand-written; missing core fields: no title/u);
  assert.match(out.text, /global-log\.md\s+missing/u);

  const install = updateTemplates(v, { apply: true, onlyMissing: true });
  assert.deepEqual(install.add, ["global-log.md"]);
  assert.equal(read(tpl(v, "decision.md")), OLD_DECISION, "install never touches an existing template");

  const dry = updateTemplates(v);
  assert.deepEqual(dry.upgrade, ["decision.md"]);
  assert.deepEqual(dry.keep.map((t) => t.name).sort(), ["pitfall.md", "project-rules.md"]);
  assert.equal(read(tpl(v, "decision.md")), OLD_DECISION, "dry run");

  const now = new Date(2026, 10, 28, 8, 0, 0);
  const all = updateTemplates(v, { apply: true, replaceCustom: true, now });
  assert.deepEqual(all.upgrade, ["decision.md"]);
  assert.deepEqual(all.replace.sort(), ["pitfall.md", "project-rules.md"]);
  assert.equal(all.backupDir, "00-System/template-backups/20261128-080000");
  assert.equal(read(path.join(v, "00-System", "template-backups", "20261128-080000", "pitfall.md")), HANDWRITTEN);
  assert.ok(templateStatus(v).every((t) => t.state === "current"));
  assert.equal(templateNotice(v), null);
  fs.rmSync(v, { recursive: true, force: true });
});

test("setup's notice and omem check flag templates that lack core fields", () => {
  const v = vaultWith({ "pitfall.md": HANDWRITTEN, "decision.md": OLD_DECISION });
  assert.match(templateNotice(v), /1 lack core fields \(pitfall\.md\); 1 from an older plugin version/u);
  write(path.join(v, "AGENTS.md"), "# Vault\n");
  write(path.join(v, "Home.md"), "# Home\n");
  const report = checkVault(v);
  assert.ok(report.issues.some((i) => /Templates without the core fields: pitfall\.md/u.test(i)));
  assert.ok(report.system.warnings.some((w) => /older plugin version.*decision\.md/u.test(w)));
  assert.equal(templateNotice(tmp("om-tpl-empty-")), null, "an uninitialized Vault says nothing");
  fs.rmSync(v, { recursive: true, force: true });
});

test("import: templates are never conflicts, CRLF-only differences are identical, --use-incoming-templates backs up and replaces", () => {
  const base = tmp("om-tpl-import-");
  const mac = vaultWith();
  write(path.join(mac, "AGENTS.md"), "# Vault\n\nRules.\n");
  write(path.join(mac, "10-Global", "preferences.md"), "---\ntitle: Preferences\n---\n\n- Mac\n");
  const { bundle } = buildExport(mac, { layaDir: path.join(base, "none") });

  // A Windows Vault: CRLF everywhere, a hand-written decision template and an unedited old pitfall one.
  const win = vaultWith({ "decision.md": crlf(HANDWRITTEN), "pitfall.md": crlf(bundledTemplate("pitfall.md").replace("deprecated: false\n", "")) });
  for (const name of TEMPLATE_NAMES.filter((n) => n !== "decision.md" && n !== "pitfall.md")) write(tpl(win, name), crlf(bundledTemplate(name)));
  write(path.join(win, "AGENTS.md"), "# Vault\r\n\r\nRules.\r\n");
  write(path.join(win, "10-Global", "preferences.md"), "---\r\ntitle: Preferences\r\n---\r\n\r\n- Windows\r\n");

  const now = new Date(2026, 10, 28, 9, 0, 0);
  const plan = planImport(bundle, { targetVault: win, layaDir: path.join(base, "none"), now });
  assert.deepEqual(plan.vault.conflicts.map((c) => c.rel), ["10-Global/preferences.md"], "only real content differences");
  assert.ok(plan.vault.same.includes("AGENTS.md"), "CRLF vs LF");
  assert.ok(plan.vault.same.includes("00-System/templates/knowledge.md"));
  assert.deepEqual(plan.templates.upgraded, ["pitfall.md"]);
  assert.deepEqual(plan.templates.keptLocal.map((k) => [k.name, k.local, k.incoming]), [["decision.md", "incompatible", "current"]]);
  applyImport(plan);
  assert.equal(classifyTemplate("pitfall.md", read(tpl(win, "pitfall.md"))).state, "current");
  assert.equal(read(tpl(win, "decision.md")), crlf(HANDWRITTEN));

  const replace = planImport(bundle, { targetVault: win, layaDir: path.join(base, "none"), useIncomingTemplates: true, now });
  assert.deepEqual(replace.templates.replaced, [{ name: "decision.md", local: "incompatible", incoming: "current" }]);
  applyImport(replace);
  assert.equal(read(tpl(win, "decision.md")), bundledTemplate("decision.md"));
  assert.equal(read(path.join(win, "00-System", "template-backups", "20261128-090000", "decision.md")), crlf(HANDWRITTEN));
  for (const dir of [base, mac, win]) fs.rmSync(dir, { recursive: true, force: true });
});

test("the digest fills core fields a Vault candidate template lacks, and skips one with broken frontmatter", () => {
  const v = tmp("om-tpl-digest-");
  const fields = {
    id: "cand-1", title: "标题", scope: "project", created: "2026-11-28T00:00:00.000Z", sourceRef: "codex session s1",
    projectId: "app-1", evidence: "证据", context: "上下文", related: "- None", meta: { origin: "auto-digest" }
  };
  write(tpl(v, "inbox-memory-candidate.md"), "---\nid: \"{{candidate_id}}\"\ntitle: \"{{title}}\"\nstatus: pending-ingest\n---\n\n# {{title}}\n");
  assert.equal(candidateTemplate(v).source, "vault");
  const text = renderCandidate(candidateTemplate(v).text, fields);
  for (const key of ["schema_version", "id", "title", "type", "scope", "project_id", "status", "created", "sensitivity", "source_ref"]) {
    assert.equal(text.match(new RegExp(`^${key}:`, "gmu"))?.length, 1, key);
  }
  assert.match(text, /^project_id: "app-1"$/mu);
  write(tpl(v, "inbox-memory-candidate.md"), "---\nid: \"{{candidate_id}}\"\ntitle: \"{{title}}\"\ncreated: {{date}}\n---\n\n# {{title}}\n");
  assert.equal(candidateTemplate(v).source, "bundled");
  fs.rmSync(v, { recursive: true, force: true });
});
