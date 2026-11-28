#!/usr/bin/env node
/**
 * One-time Claude Code setup: writes the Obsidian Memory managed block (the standing instruction and the
 * user's Vault path) into the user-level ~/.claude/CLAUDE.md (or $CLAUDE_CONFIG_DIR/CLAUDE.md), which
 * Claude Code loads in every project. The plugin itself (skill and hooks) is installed with Claude Code's
 * plugin commands; this script prints them and never runs them.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { assertSafePath, updateContentWithBlock, validateVaultPath } from "../lib/managed-block.js";
import { linkOmem } from "../lib/cli-link.js";
import { templateNotice } from "../lib/vault-templates.js";

export const CLAUDE_INSTALL_COMMANDS = [
  "claude plugin install obsidian-memory --marketplace annual30k/obsidian-memory-plugin"
];

export function claudeHome(env = process.env, home = homedir()) {
  return env.CLAUDE_CONFIG_DIR?.trim() || resolve(home, ".claude");
}

export function defaultClaudeMdPath(env = process.env, home = homedir()) {
  return resolve(claudeHome(env, home), "CLAUDE.md");
}

export function updateClaudeMdContent(content, vaultPath) {
  return updateContentWithBlock(content, vaultPath, "CLAUDE.md");
}

function parseArgs(args) {
  const options = { claudeMdPath: defaultClaudeMdPath(), confirm: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vault" || arg === "--claude-md") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      if (arg === "--vault") options.vaultPath = value;
      else options.claudeMdPath = value;
      index += 1;
    } else if (arg === "--yes") {
      options.confirm = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new TypeError(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function help(output) {
  output.write(`Usage: node scripts/setup-claude.mjs [--vault <absolute-path>] [--yes] [--dry-run]

Prompts for an Obsidian Vault path, validates that it is readable, then safely adds this plugin's
managed block to the user-level Claude Code memory file (~/.claude/CLAUDE.md, or CLAUDE.md under
$CLAUDE_CONFIG_DIR). Only the block between the obsidian-memory-plugin markers is added or replaced.
--yes requires --vault. --claude-md <absolute-path> targets a different file.

Install the plugin (skill + UserPromptSubmit/Stop hooks) in Claude Code with:
  ${CLAUDE_INSTALL_COMMANDS.join("\n  ")}
`);
}

function validateClaudeMdPath(value) {
  const file = assertSafePath(value, "CLAUDE.md path");
  if (existsSync(file) && !lstatSync(file).isFile()) throw new TypeError("CLAUDE.md path must be a regular file when it already exists");
  return file;
}

export async function runSetup(args, { input = process.stdin, output = process.stdout } = {}) {
  const options = parseArgs(args);
  if (options.help) return help(output);
  if (options.confirm && !options.vaultPath) throw new TypeError("--yes requires an explicit --vault path");
  const prompt = createInterface({ input, output });
  try {
    const supplied = options.vaultPath ?? process.env.OBSIDIAN_MEMORY_VAULT ?? await prompt.question("Obsidian Vault absolute path: ");
    const vaultPath = validateVaultPath(supplied);
    const claudeMdPath = validateClaudeMdPath(options.claudeMdPath);
    const previous = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";
    const next = updateClaudeMdContent(previous, vaultPath);
    if (options.dryRun) {
      output.write(next);
      return;
    }
    if (!options.confirm) {
      const answer = await prompt.question(`Enable Obsidian Memory for all Claude Code projects by updating ${claudeMdPath}? [y/N] `);
      if (!/^(y|yes)$/i.test(answer.trim())) {
        output.write("No files changed.\n");
        return;
      }
    }
    mkdirSync(dirname(claudeMdPath), { recursive: true });
    if (next !== previous) writeFileSync(claudeMdPath, next, "utf8");
    output.write(`Configured Obsidian Memory in ${claudeMdPath}.\n`);
    linkOmem(output);
    const templates = templateNotice(vaultPath);
    if (templates) output.write(`${templates}\n`);
    output.write(`If the plugin is not installed in Claude Code yet, run:\n  ${CLAUDE_INSTALL_COMMANDS.join("\n  ")}\nThen start a new Claude Code session.\n`);
  } finally {
    prompt.close();
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) {
  runSetup(process.argv.slice(2)).catch((error) => {
    console.error(`Claude Code setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
