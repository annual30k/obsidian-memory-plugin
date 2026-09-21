import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateVaultPath } from "../lib/managed-block.js";

export const HERMES_PLUGIN_ID = "obsidian-memory-plugin";
export const HERMES_VAULT_KEY = `plugins.entries.${HERMES_PLUGIN_ID}.settings.vault_path`;

function parseArgs(args) {
  const options = { hermesBin: "hermes", confirm: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vault" || arg === "--hermes-bin") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      options[arg === "--vault" ? "vaultPath" : "hermesBin"] = value;
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

export function hermesConfigArgs(vaultPath) {
  return ["config", "set", HERMES_VAULT_KEY, vaultPath];
}

function help(output = process.stdout) {
  output.write(`Usage: node scripts/setup-hermes.mjs [--vault <absolute-path>] [--yes] [--dry-run]\n\nPrompts for an existing Obsidian Vault, verifies it is readable, then asks Hermes to save\nthat path only in this plugin's settings. The plugin must also be enabled with:\n  hermes plugins enable ${HERMES_PLUGIN_ID}\n`);
}

export async function runSetup(args, { input = process.stdin, output = process.stdout, run = spawnSync } = {}) {
  const options = parseArgs(args);
  if (options.help) return help(output);
  if (options.confirm && !options.vaultPath) throw new TypeError("--yes requires an explicit --vault path");
  const prompt = createInterface({ input, output });
  try {
    const suppliedVault = options.vaultPath ?? process.env.OBSIDIAN_MEMORY_VAULT ?? await prompt.question("Obsidian Vault absolute path: ");
    const vaultPath = validateVaultPath(suppliedVault);
    const command = hermesConfigArgs(vaultPath);
    if (options.dryRun) {
      output.write([options.hermesBin, ...command].map(JSON.stringify).join(" ") + "\n");
      return;
    }
    if (!options.confirm) {
      const answer = await prompt.question(`Save this Vault path in Hermes plugin settings? [y/N] `);
      if (!/^(y|yes)$/i.test(answer.trim())) {
        output.write("No files changed.\n");
        return;
      }
    }
    const result = run(options.hermesBin, command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error) throw new TypeError(`could not run ${options.hermesBin}: ${result.error.message}`);
    if (result.status !== 0) throw new TypeError((result.stderr || result.stdout || "Hermes rejected the configuration").trim());
    output.write("Configured Obsidian Memory for Hermes. Start a new Hermes session to use the updated guidance.\n");
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
    console.error(`Hermes setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
