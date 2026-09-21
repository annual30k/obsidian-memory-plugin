import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  assertSafePath,
  END_MARKER,
  managedBlock,
  START_MARKER,
  TRIGGER_INSTRUCTION,
  updateContentWithBlock,
  validateVaultPath
} from "../lib/managed-block.js";

export { END_MARKER, managedBlock, START_MARKER, TRIGGER_INSTRUCTION, validateVaultPath };

export function defaultAgentsPath(codexHome = resolve(homedir(), ".codex")) {
  const overridePath = resolve(codexHome, "AGENTS.override.md");
  if (existsSync(overridePath)) {
    if (!lstatSync(overridePath).isFile()) {
      throw new TypeError("Codex AGENTS.override.md must be a regular file");
    }
    if (readFileSync(overridePath, "utf8").trim()) return overridePath;
  }
  return resolve(codexHome, "AGENTS.md");
}

export function updateAgentsContent(content, vaultPath) {
  return updateContentWithBlock(content, vaultPath, "AGENTS.md");
}

function parseArgs(args) {
  const options = { agentsPath: defaultAgentsPath(), confirm: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vault" || arg === "--agents-file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      options[arg === "--vault" ? "vaultPath" : "agentsPath"] = value;
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

function help() {
  console.log(`Usage: node scripts/setup-codex.mjs [--vault <absolute-path>] [--yes] [--dry-run]

Prompts for an Obsidian Vault path, validates that it is readable, then safely
adds this plugin's managed block to the active global AGENTS file (AGENTS.override.md
when non-empty, otherwise AGENTS.md). --yes requires --vault.
Use --agents-file <absolute-path> only to target a different AGENTS file.`);
}

function validateAgentsPath(value) {
  const agentsPath = assertSafePath(value, "AGENTS.md path");
  if (existsSync(agentsPath) && !lstatSync(agentsPath).isFile()) {
    throw new TypeError("AGENTS.md path must be a regular file when it already exists");
  }
  return agentsPath;
}

export async function runSetup(args, { input = process.stdin, output = process.stdout } = {}) {
  const options = parseArgs(args);
  if (options.help) return help();
  if (options.confirm && !options.vaultPath) throw new TypeError("--yes requires an explicit --vault path");
  const prompt = createInterface({ input, output });
  try {
    const suppliedVault = options.vaultPath ?? process.env.OBSIDIAN_MEMORY_VAULT ?? await prompt.question("Obsidian Vault absolute path: ");
    const vaultPath = validateVaultPath(suppliedVault);
    const agentsPath = validateAgentsPath(options.agentsPath);
    const previous = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
    const next = updateAgentsContent(previous, vaultPath);
    if (options.dryRun) {
      output.write(next);
      return;
    }
    if (!options.confirm) {
      const answer = await prompt.question(`Enable Obsidian Memory for all Codex code tasks by updating ${agentsPath}? [y/N] `);
      if (!/^(y|yes)$/i.test(answer.trim())) {
        output.write("No files changed.\n");
        return;
      }
    }
    mkdirSync(dirname(agentsPath), { recursive: true });
    writeFileSync(agentsPath, next, "utf8");
    output.write(`Configured Obsidian Memory in ${agentsPath}. Start a new Codex task to use the updated instruction.\n`);
  } finally {
    prompt.close();
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isEntrypoint) {
  runSetup(process.argv.slice(2)).catch(error => {
    console.error(`Codex setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
