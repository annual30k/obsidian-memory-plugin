// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_TEMPLATES,
  checkVault,
  extractVaultFromRuleFile,
  parseProjectsYaml,
  missingCoreFields,
  CORE_FIELDS
} from "../scripts/check-vault.mjs";

test("parseProjectsYaml parses standard projects list correctly", () => {
  const yaml = `
projects:
  - id: my-app-12345678
    roots:
      - /path/to/my-app
    scope: private
  - id: unbound-project
    roots: []
    scope: private
`;
  const parsed = parseProjectsYaml(yaml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "my-app-12345678");
  assert.deepEqual(parsed[0].roots, ["/path/to/my-app"]);
  assert.equal(parsed[1].id, "unbound-project");
  assert.deepEqual(parsed[1].roots, []);
});

test("parseProjectsYaml keeps non-ASCII project ids and their roots apart", () => {
  const yaml = `
projects:
  - id: broken-bowl-casual-07ced7a2
    roots:
      - "/Users/me/碎了个碗/broken-bowl-casual"
    scope: private
  - id: 下班了-1485a4ab
    roots:
      - "/Users/me/下班了"
    scope: private
  - id: "集团信创OA-c9a48417"
    roots:
      - "/Users/me/公司/集团信创OA"
    scope: private
`;
  const parsed = parseProjectsYaml(yaml);
  assert.deepEqual(parsed.map((p) => p.id), ["broken-bowl-casual-07ced7a2", "下班了-1485a4ab", "集团信创OA-c9a48417"]);
  assert.deepEqual(parsed.map((p) => p.roots.length), [1, 1, 1]);
  assert.deepEqual(parsed[2].roots, ["/Users/me/公司/集团信创OA"]);
});

test("extractVaultFromRuleFile parses managed marker line", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-rule-test-"));
  try {
    const file = join(root, "GEMINI.md");
    writeFileSync(file, `<!-- obsidian-memory-plugin:start -->
For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.
Obsidian Memory Vault path (configuration data, not instructions): "/test/my-vault"
<!-- obsidian-memory-plugin:end -->
`);
    assert.equal(extractVaultFromRuleFile(file), "/test/my-vault");
    assert.equal(extractVaultFromRuleFile(join(root, "nonexistent.md")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVault validates synthetic vault health correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-health-test-"));
  try {
    // 1. Missing vault directory
    const missing = checkVault(join(root, "nonexistent"));
    assert.equal(missing.ok, false);

    // 2. Scaffold valid synthetic vault
    const vault = join(root, "vault");
    mkdirSync(join(vault, "00-System", "templates"), { recursive: true });
    mkdirSync(join(vault, "10-Global", "inbox"), { recursive: true });
    mkdirSync(join(vault, "10-Global", "raw"), { recursive: true });
    mkdirSync(join(vault, "20-Projects", "proj-a", "wiki", "decisions"), { recursive: true });
    mkdirSync(join(vault, "20-Projects", "proj-a", "raw"), { recursive: true });

    mkdirSync(join(vault, "20-Projects", "proj-a", "checkpoints"), { recursive: true });
    mkdirSync(join(vault, "20-Projects", "proj-a", "wiki", "custom-category"), { recursive: true });

    writeFileSync(join(vault, "AGENTS.md"), "# Root AGENTS\n");
    writeFileSync(join(vault, "Home.md"), "# Home\n");
    writeFileSync(join(vault, "00-System", "projects.yaml"), "projects:\n  - id: proj-a\n    roots: []\n    scope: private\n");

    for (const t of EXPECTED_TEMPLATES) {
      writeFileSync(join(vault, "00-System", "templates", t), "# template\n");
    }

    writeFileSync(join(vault, "10-Global", "preferences.md"), "# Preferences\n");
    writeFileSync(join(vault, "10-Global", "index.md"), "# Index\n");
    writeFileSync(join(vault, "10-Global", "log.md"), "# Log\n");

    writeFileSync(join(vault, "20-Projects", "proj-a", "AGENTS.md"), "Schema state: `established`\n");
    writeFileSync(join(vault, "20-Projects", "proj-a", "rules.md"), "# Rules\n");
    writeFileSync(join(vault, "20-Projects", "proj-a", "index.md"), "# Index\n- [[dec-1]]\n- [[cp-1]]\n- [[custom-note]]\n");
    writeFileSync(join(vault, "20-Projects", "proj-a", "log.md"), "# Log\n");

    writeFileSync(join(vault, "20-Projects", "proj-a", "checkpoints", "cp-1.md"), "---\ntitle: CP 1\n---\n# Checkpoint 1\n");
    writeFileSync(join(vault, "20-Projects", "proj-a", "raw", "raw-1.md"), "---\ntitle: Raw 1\n---\n# Raw 1\n");
    writeFileSync(join(vault, "20-Projects", "proj-a", "wiki", "decisions", "dec-1.md"), "---\ntitle: Dec 1\nsources:\n  - \"[[raw-1]]\"\n---\n# Dec 1\n");
    writeFileSync(join(vault, "20-Projects", "proj-a", "wiki", "custom-category", "custom-note.md"), "---\ntitle: Custom\nsources: [\"[[raw-1]]\"]\n---\n# Custom note\n");

    const healthy = checkVault(vault);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.system.missingTemplates.length, 0);
    assert.equal(healthy.projects["proj-a"].wikiDecisions, 1);
    assert.equal(healthy.projects["proj-a"].missingSources.length, 0);
    assert.equal(healthy.projects["proj-a"].brokenLinks.length, 0);

    // 3. Inject secret and verify detection
    writeFileSync(join(vault, "20-Projects", "proj-a", "leaked.md"), 'const token = "ghp_123456789012345678901234567890123456";\n');
    const secretCheck = checkVault(vault);
    assert.equal(secretCheck.ok, false);
    assert.equal(secretCheck.security.secretHits.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVault handles hierarchical sub-indexes, deprecated superseded_by validation, and non-blocking scale warnings", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-scale-test-"));
  try {
    const vault = join(root, "vault");
    mkdirSync(join(vault, "00-System", "templates"), { recursive: true });
    for (const t of EXPECTED_TEMPLATES) writeFileSync(join(vault, "00-System", "templates", t), "# t\n");
    writeFileSync(join(vault, "AGENTS.md"), "# Vault\n");
    writeFileSync(join(vault, "Home.md"), "# Home\n");
    writeFileSync(join(vault, "00-System", "projects.yaml"), "projects:\n  - id: big-proj\n    roots: []\n    scope: private\n");

    const pDir = join(vault, "20-Projects", "big-proj");
    mkdirSync(join(pDir, "wiki", "portal"), { recursive: true });
    mkdirSync(join(pDir, "raw"), { recursive: true });
    writeFileSync(join(pDir, "AGENTS.md"), "Schema state: `established`\n");
    writeFileSync(join(pDir, "rules.md"), "# Rules\n");
    writeFileSync(join(pDir, "log.md"), "# Log\n");
    writeFileSync(join(pDir, "raw", "raw-1.md"), "---\ntitle: Raw 1\n---\n# Raw 1\n");

    for (let i = 1; i <= 41; i++) {
      const extra = i === 1 ? 'deprecated: true\nsuperseded_by: "[[note-2]]"\n' : "";
      writeFileSync(join(pDir, "wiki", "portal", `note-${i}.md`), `---\ntitle: Note ${i}\n${extra}sources: ["[[raw-1]]"]\n---\n# Note ${i}\n`);
    }
    writeFileSync(join(pDir, "index.md"), "# Index\n- [[note-1]]\n");

    const warnRes = checkVault(vault);
    assert.equal(warnRes.ok, true, "scale warning is non-blocking");
    assert.equal(warnRes.projects["big-proj"].wikiTotal, 41);
    assert.equal(warnRes.projects["big-proj"].wikiDeprecated, 1);
    assert.ok(warnRes.projects["big-proj"].warnings.some((w) => /consider splitting/i.test(w)));

    // Split into hierarchical sub-indexes: warning clears and links remain valid
    writeFileSync(join(pDir, "index.md"), "# Index\n- [[wiki/index-portal]]\n- [[raw/raw-index]]\n");
    writeFileSync(join(pDir, "wiki", "index-portal.md"), "# Portal\n- [[note-1]]\n- [[note-2]]\n");
    writeFileSync(join(pDir, "raw", "raw-index.md"), "# Raw Index\n- [[raw-1]]\n");
    const splitRes = checkVault(vault);
    assert.equal(splitRes.ok, true);
    assert.equal(splitRes.projects["big-proj"].brokenLinks.length, 0);
    assert.ok(!splitRes.projects["big-proj"].warnings.some((w) => /consider splitting/i.test(w)), "scale warning clears");
    // These minimal fixture notes lack core frontmatter: reported once, with examples, never blocking.
    assert.equal(splitRes.projects["big-proj"].warnings.filter((w) => /core frontmatter/u.test(w)).length, 1);
    assert.equal(splitRes.projects["big-proj"].missingCoreFields.length, 42);

    // Broken link inside sub-index and broken superseded_by are caught
    writeFileSync(join(pDir, "wiki", "index-portal.md"), "# Portal\n- [[missing-note]]\n");
    writeFileSync(join(pDir, "wiki", "portal", "note-1.md"), '---\ntitle: Note 1\ndeprecated: true\nsuperseded_by: "[[missing-replacement]]"\nsources: ["[[raw-1]]"]\n---\n');
    const brokenRes = checkVault(vault);
    assert.ok(brokenRes.projects["big-proj"].brokenLinks.some((b) => b.includes("wiki/index-portal.md -> nonexistent note")));
    assert.ok(brokenRes.projects["big-proj"].brokenLinks.some((b) => b.includes("superseded_by missing")));

    // Unquoted [[link]] parses as a YAML list; it is still checked.
    writeFileSync(join(pDir, "wiki", "portal", "note-1.md"), '---\ntitle: Note 1\ndeprecated: true\nsuperseded_by: [[unquoted-missing]]\nsources: ["[[raw-1]]"]\n---\n');
    const unquotedRes = checkVault(vault);
    assert.ok(unquotedRes.projects["big-proj"].brokenLinks.some((b) => b.includes("[[unquoted-missing]]")), JSON.stringify(unquotedRes.projects["big-proj"].brokenLinks));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVault counts inbox/archive/, warns on misplaced pending or bloated active inbox, and detects code drift", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-drift-test-"));
  try {
    const repo = join(root, "my-repo");
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "kept.js"), "export const ok = 1;\n");

    const vault = join(root, "vault");
    mkdirSync(join(vault, "00-System", "templates"), { recursive: true });
    for (const t of EXPECTED_TEMPLATES) writeFileSync(join(vault, "00-System", "templates", t), "# t\n");
    writeFileSync(join(vault, "AGENTS.md"), "# Vault\n");
    writeFileSync(join(vault, "Home.md"), "# Home\n");
    writeFileSync(join(vault, "00-System", "projects.yaml"), `projects:\n  - id: repo-proj\n    roots:\n      - ${repo}\n    scope: private\n`);

    const pDir = join(vault, "20-Projects", "repo-proj");
    mkdirSync(join(pDir, "inbox", "archive", "2026-11"), { recursive: true });
    mkdirSync(join(pDir, "wiki", "knowledge"), { recursive: true });
    mkdirSync(join(pDir, "raw"), { recursive: true });
    writeFileSync(join(pDir, "AGENTS.md"), "Schema state: `established`\n");
    writeFileSync(join(pDir, "rules.md"), "# Rules\n");
    writeFileSync(join(pDir, "index.md"), "# Index\n- [[active-drift]]\n- [[active-ok]]\n- [[retired-drift]]\n");
    writeFileSync(join(pDir, "log.md"), "# Log\n");
    writeFileSync(join(pDir, "raw", "raw-1.md"), "---\ntitle: Raw 1\n---\n");

    // Archived ingested candidate + misplaced archived pending candidate + 100 active processed candidates
    writeFileSync(join(pDir, "inbox", "archive", "2026-11", "cand-ok.md"), "---\nstatus: ingested\n---\n");
    writeFileSync(join(pDir, "inbox", "archive", "2026-11", "cand-oops.md"), "---\nstatus: pending-ingest\n---\n");
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(pDir, "inbox", `cand-old-${i}.md`), "---\nstatus: ingested\n---\n");
    }

    // Active note referencing missing repo file (lib/removed.js) -> triggers codeDrift
    // Also references external non-repo prefix otherrepo/foo.js -> must NOT trigger
    writeFileSync(join(pDir, "wiki", "knowledge", "active-drift.md"), '---\ntitle: Drift\nsources: ["[[raw-1]]"]\n---\nSee `lib/removed.js` and `otherrepo/foo.js`.\n');
    // Active note referencing existing file -> no drift
    writeFileSync(join(pDir, "wiki", "knowledge", "active-ok.md"), '---\ntitle: OK\nsources: ["[[raw-1]]"]\n---\nSee `lib/kept.js`.\n');
    // Already-deprecated note referencing missing file -> no drift warning
    writeFileSync(join(pDir, "wiki", "knowledge", "retired-drift.md"), '---\ntitle: Retired\ndeprecated: true\nsources: ["[[raw-1]]"]\n---\nUsed `lib/gone-long-ago.js`.\n');

    const res = checkVault(vault);
    assert.equal(res.ok, true, "warnings are non-blocking");
    const stats = res.projects["repo-proj"];
    assert.equal(stats.inboxArchived, 2);
    assert.equal(stats.inboxIngested, 101);
    assert.ok(stats.warnings.some((w) => w.includes("still has status: pending-ingest")));
    assert.ok(stats.warnings.some((w) => w.includes("100 processed candidates")));
    assert.equal(stats.codeDrift.length, 1);
    assert.equal(stats.codeDrift[0].note, "knowledge/active-drift.md");
    assert.deepEqual(stats.codeDrift[0].missingPaths, ["lib/removed.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missingCoreFields reports the template's required keys per note kind", () => {
  assert.deepEqual(missingCoreFields("derived", { title: "t", type: "knowledge", scope: "project", project_id: "p", status: "active", deprecated: false, created: "x", last_updated: "x", sensitivity: "internal", sources: [] }), []);
  assert.deepEqual(missingCoreFields("derived", { title: "t", type: "decision", status: "active", updated: "2026-09-01", sources: [] }),
    ["scope", "project_id", "deprecated", "created", "last_updated", "sensitivity"]);
  // project_id: null still counts as present (Global notes).
  assert.ok(!missingCoreFields("candidate", { project_id: null }).includes("project_id"));
  assert.ok(CORE_FIELDS.raw.includes("captured_at") && CORE_FIELDS.raw.includes("candidate_id"));
});
