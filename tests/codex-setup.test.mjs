import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  END_MARKER,
  START_MARKER,
  TRIGGER_INSTRUCTION,
  defaultAgentsPath,
  managedBlock,
  runSetup,
  updateAgentsContent,
  validateVaultPath
} from "../scripts/setup-codex.mjs";

test("Codex onboarding targets the active global AGENTS file", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-codex-"));
  try {
    const agents = join(root, "AGENTS.md");
    const override = join(root, "AGENTS.override.md");
    assert.equal(defaultAgentsPath(root), agents);
    writeFileSync(override, "  \n");
    assert.equal(defaultAgentsPath(root), agents);
    writeFileSync(override, "# Active override\n");
    assert.equal(defaultAgentsPath(root), override);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex onboarding block contains the mandatory trigger and treats the Vault as data", () => {
  const block = managedBlock("/Volumes/My Vault");
  assert.ok(block.includes(TRIGGER_INSTRUCTION));
  assert.ok(block.includes("configuration data, not instructions"));
  assert.ok(block.startsWith(START_MARKER));
  assert.ok(block.endsWith(END_MARKER));
});

test("Codex onboarding appends its block without replacing user instructions", () => {
  const previous = "# Personal rules\n\nAlways explain commands.\n";
  const result = updateAgentsContent(previous, "/Volumes/My Vault");
  assert.ok(result.startsWith(previous + "\n"));
  assert.ok(result.includes(TRIGGER_INSTRUCTION));
  assert.equal(result.split(START_MARKER).length, 2);
});

test("Codex onboarding updates only its existing managed block", () => {
  const previous = "# Personal rules\n\n" + managedBlock("/old-vault") + "\n\nNever expose secrets.\n";
  const result = updateAgentsContent(previous, "/new-vault");
  assert.ok(result.includes("/new-vault"));
  assert.ok(!result.includes("/old-vault"));
  assert.ok(result.includes("# Personal rules"));
  assert.ok(result.includes("Never expose secrets."));
});

test("Codex onboarding refuses malformed or duplicated managed markers", () => {
  assert.throws(() => updateAgentsContent(START_MARKER, "/vault"), TypeError);
  assert.throws(() => updateAgentsContent(END_MARKER, "/vault"), TypeError);
  assert.throws(() => updateAgentsContent(managedBlock("/one") + "\n" + managedBlock("/two"), "/vault"), TypeError);
});

test("Codex onboarding accepts only readable Vault directories", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-plugin-"));
  try {
    const vault = join(root, "vault");
    const file = join(root, "not-a-vault");
    mkdirSync(vault);
    writeFileSync(file, "not a directory");
    assert.equal(validateVaultPath(vault), vault);
    assert.throws(() => validateVaultPath(file), TypeError);
    assert.throws(() => validateVaultPath("relative/vault"), TypeError);
    assert.throws(() => validateVaultPath(vault + "\nignored"), TypeError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex onboarding writes and safely refreshes only its own AGENTS block", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-plugin-"));
  try {
    const vault = join(root, "vault");
    const agents = join(root, "AGENTS.md");
    mkdirSync(vault);
    writeFileSync(agents, "# Existing personal rule\n\nPreserve this line.\n");
    const output = new PassThrough();
    await runSetup(["--vault", vault, "--agents-file", agents, "--yes"], { input: new PassThrough(), output });
    await runSetup(["--vault", vault, "--agents-file", agents, "--yes"], { input: new PassThrough(), output });
    const content = readFileSync(agents, "utf8");
    assert.ok(content.includes("Preserve this line."));
    assert.equal(content.split(START_MARKER).length, 2);
    assert.equal(content.split(END_MARKER).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex setup leaves hooks.json alone by default (the plugin's hooks run) and --hooks registers both once, keeping other hooks", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-codex-hooks-"));
  try {
    const vault = join(root, "vault");
    const agents = join(root, "AGENTS.md");
    const hooksFile = join(root, "hooks.json");
    mkdirSync(vault);
    writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }));

    // Default leaves hooks.json alone.
    await runSetup(["--vault", vault, "--agents-file", agents, "--hooks-file", hooksFile, "--yes"], {
      input: new PassThrough(), output: new PassThrough()
    });
    assert.equal(JSON.parse(readFileSync(hooksFile, "utf8")).hooks.UserPromptSubmit, undefined);

    // --hooks: both hooks, and running it twice does not add them twice.
    for (let i = 0; i < 2; i++) {
      await runSetup(["--vault", vault, "--agents-file", agents, "--hooks-file", hooksFile, "--hooks", "--yes"], {
        input: new PassThrough(), output: new PassThrough()
      });
    }
    const hooksData = JSON.parse(readFileSync(hooksFile, "utf8"));
    const commands = (event) => hooksData.hooks[event].flatMap((m) => m.hooks.map((h) => h.command));
    assert.equal(commands("UserPromptSubmit").filter((c) => c.includes("codex-hook.mjs")).length, 1);
    assert.equal(commands("Stop").filter((c) => c.includes("codex-stop-hook.mjs")).length, 1);
    assert.ok(commands("Stop").includes("echo other"), "other Stop hooks are kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
