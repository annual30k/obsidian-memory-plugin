import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_TEMPLATES,
  checkVault,
  extractVaultFromRuleFile,
  parseProjectsYaml
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
