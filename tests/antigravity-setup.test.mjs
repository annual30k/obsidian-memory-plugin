import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  END_MARKER,
  START_MARKER,
  TRIGGER_INSTRUCTION,
  defaultGeminiPath,
  defaultPluginInstallDir,
  linkPlugin,
  managedBlock,
  runSetup,
  updateGeminiContent,
  validateVaultPath
} from "../scripts/setup-antigravity.mjs";

test("Antigravity onboarding targets the global GEMINI.md file", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-antigravity-"));
  try {
    const gemini = join(root, "GEMINI.md");
    assert.equal(defaultGeminiPath(root), gemini);
    assert.equal(defaultPluginInstallDir(join(root, "config", "plugins")), join(root, "config", "plugins", "obsidian-memory-plugin"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity onboarding block contains the mandatory trigger and treats the Vault as data", () => {
  const block = managedBlock("/Volumes/My Vault");
  assert.ok(block.includes(TRIGGER_INSTRUCTION));
  assert.ok(block.includes("configuration data, not instructions"));
  assert.ok(block.startsWith(START_MARKER));
  assert.ok(block.endsWith(END_MARKER));
});

test("Antigravity onboarding appends its block without replacing user instructions", () => {
  const previous = "# Personal rules\n\nAlways explain commands.\n";
  const result = updateGeminiContent(previous, "/Volumes/My Vault");
  assert.ok(result.startsWith(previous + "\n"));
  assert.ok(result.includes(TRIGGER_INSTRUCTION));
  assert.equal(result.split(START_MARKER).length, 2);
});

test("Antigravity onboarding updates only its existing managed block", () => {
  const previous = "# Personal rules\n\n" + managedBlock("/old-vault") + "\n\nNever expose secrets.\n";
  const result = updateGeminiContent(previous, "/new-vault");
  assert.ok(result.includes("/new-vault"));
  assert.ok(!result.includes("/old-vault"));
  assert.ok(result.includes("# Personal rules"));
  assert.ok(result.includes("Never expose secrets."));
});

test("Antigravity onboarding refuses malformed or duplicated managed markers", () => {
  assert.throws(() => updateGeminiContent(START_MARKER, "/vault"), TypeError);
  assert.throws(() => updateGeminiContent(END_MARKER, "/vault"), TypeError);
  assert.throws(() => updateGeminiContent(managedBlock("/one") + "\n" + managedBlock("/two"), "/vault"), TypeError);
});

test("Antigravity onboarding accepts only readable Vault directories", () => {
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

test("Antigravity onboarding writes and safely refreshes only its own GEMINI block", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-plugin-"));
  try {
    const vault = join(root, "vault");
    const gemini = join(root, "GEMINI.md");
    const pluginDir = join(root, "plugins", "obsidian-memory-plugin");
    mkdirSync(vault);
    writeFileSync(gemini, "# Existing personal rule\n\nPreserve this line.\n");
    const output = new PassThrough();
    await runSetup(["--vault", vault, "--gemini-file", gemini, "--plugin-dir", pluginDir, "--yes"], { input: new PassThrough(), output });
    await runSetup(["--vault", vault, "--gemini-file", gemini, "--plugin-dir", pluginDir, "--yes"], { input: new PassThrough(), output });
    const content = readFileSync(gemini, "utf8");
    assert.ok(content.includes("Preserve this line."));
    assert.equal(content.split(START_MARKER).length, 2);
    assert.equal(content.split(END_MARKER).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity onboarding dry-run outputs content without modifying files", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-plugin-"));
  try {
    const vault = join(root, "vault");
    const gemini = join(root, "GEMINI.md");
    mkdirSync(vault);
    writeFileSync(gemini, "# Existing rule\n");
    let dryOutput = "";
    const output = new PassThrough();
    output.on("data", chunk => { dryOutput += chunk.toString(); });
    await runSetup(["--vault", vault, "--gemini-file", gemini, "--dry-run"], { input: new PassThrough(), output });
    assert.equal(readFileSync(gemini, "utf8"), "# Existing rule\n");
    assert.ok(dryOutput.includes(TRIGGER_INSTRUCTION));
    assert.ok(dryOutput.includes(vault));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity plugin linking handles new links and existing links safely", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-link-"));
  try {
    const sourceDir = join(root, "source");
    const targetDir = join(root, "target", "obsidian-memory-plugin");
    mkdirSync(sourceDir);
    assert.equal(linkPlugin(sourceDir, targetDir), "linked");
    assert.equal(linkPlugin(sourceDir, targetDir), "already-linked");

    // Self linking returns already-linked without error
    assert.equal(linkPlugin(sourceDir, sourceDir), "already-linked");

    // Broken symlink is safely replaced
    const brokenTarget = join(root, "target-broken");
    symlinkSync(join(root, "nonexistent"), brokenTarget);
    assert.equal(linkPlugin(sourceDir, brokenTarget), "linked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
