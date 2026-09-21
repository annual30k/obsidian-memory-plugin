import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

export function defaultGeminiPath(geminiHome = resolve(homedir(), ".gemini")) {
  return resolve(geminiHome, "GEMINI.md");
}

export function defaultPluginInstallDir(geminiConfigHome = resolve(homedir(), ".gemini", "config", "plugins")) {
  return resolve(geminiConfigHome, "obsidian-memory-plugin");
}

export function updateGeminiContent(content, vaultPath) {
  return updateContentWithBlock(content, vaultPath, "GEMINI.md");
}

export function linkPlugin(sourceDir, targetDir) {
  const safeSource = assertSafePath(sourceDir, "Source directory");
  const safeTarget = assertSafePath(targetDir, "Target plugin directory");
  let lstat;
  try {
    lstat = lstatSync(safeTarget);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (lstat) {
    if (lstat.isSymbolicLink()) {
      let existing;
      try {
        existing = realpathSync(safeTarget);
      } catch {
        // Broken symlink pointing to nonexistent path
      }
      if (existing && existing === realpathSync(safeSource)) {
        return "already-linked";
      }
      unlinkSync(safeTarget);
    } else {
      if (realpathSync(safeTarget) === realpathSync(safeSource)) {
        return "already-linked";
      }
      throw new TypeError(`Target plugin path exists and is not a symlink: ${safeTarget}`);
    }
  }
  mkdirSync(dirname(safeTarget), { recursive: true });
  symlinkSync(safeSource, safeTarget, process.platform === "win32" ? "junction" : "dir");
  return "linked";
}

function parseArgs(args) {
  const options = {
    geminiPath: defaultGeminiPath(),
    pluginDir: defaultPluginInstallDir(),
    link: true,
    confirm: false,
    dryRun: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vault" || arg === "--gemini-file" || arg === "--plugin-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      if (arg === "--vault") options.vaultPath = value;
      else if (arg === "--gemini-file") options.geminiPath = value;
      else if (arg === "--plugin-dir") options.pluginDir = value;
      index += 1;
    } else if (arg === "--link") {
      options.link = true;
    } else if (arg === "--no-link") {
      options.link = false;
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
  console.log(`Usage: node scripts/setup-antigravity.mjs [--vault <absolute-path>] [--gemini-file <absolute-path>] [--plugin-dir <absolute-path>] [--link|--no-link] [--yes] [--dry-run]

Prompts for an Obsidian Vault path, validates that it is readable, links the plugin
into Antigravity's global plugin directory (~/.gemini/config/plugins/obsidian-memory-plugin),
and safely adds or updates this plugin's managed block in the active global GEMINI.md file.

Options:
  --vault <path>        Absolute physical path of the Obsidian Vault
  --gemini-file <path>  Target GEMINI.md file (default: ~/.gemini/GEMINI.md)
  --plugin-dir <path>   Destination plugin directory (default: ~/.gemini/config/plugins/obsidian-memory-plugin)
  --link / --no-link    Whether to link the plugin directory (default: true)
  --dry-run             Print the resulting GEMINI.md content without changing files
  --yes                 Confirm automatically without interactive prompt (requires --vault)
  -h, --help            Show this help message`);
}

function validateGeminiPath(value) {
  const geminiPath = assertSafePath(value, "GEMINI.md path");
  if (existsSync(geminiPath) && !lstatSync(geminiPath).isFile()) {
    throw new TypeError("GEMINI.md path must be a regular file when it already exists");
  }
  return geminiPath;
}

export async function runSetup(args, { input = process.stdin, output = process.stdout } = {}) {
  const options = parseArgs(args);
  if (options.help) return help();
  if (options.confirm && !options.vaultPath) throw new TypeError("--yes requires an explicit --vault path");
  const prompt = createInterface({ input, output });
  try {
    const suppliedVault = options.vaultPath ?? process.env.OBSIDIAN_MEMORY_VAULT ?? await prompt.question("Obsidian Vault absolute path: ");
    const vaultPath = validateVaultPath(suppliedVault);
    const geminiPath = validateGeminiPath(options.geminiPath);
    const previous = existsSync(geminiPath) ? readFileSync(geminiPath, "utf8") : "";
    const next = updateGeminiContent(previous, vaultPath);
    if (options.dryRun) {
      output.write(next);
      return;
    }
    if (!options.confirm) {
      const answer = await prompt.question(`Enable Obsidian Memory for Antigravity code tasks by updating ${geminiPath}? [y/N] `);
      if (!/^(y|yes)$/i.test(answer.trim())) {
        output.write("No files changed.\n");
        return;
      }
    }
    mkdirSync(dirname(geminiPath), { recursive: true });
    writeFileSync(geminiPath, next, "utf8");
    output.write(`Configured Obsidian Memory in ${geminiPath}.\n`);

    if (options.link) {
      const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
      const linkStatus = linkPlugin(packageRoot, options.pluginDir);
      if (linkStatus === "already-linked") {
        output.write(`Plugin is already linked at ${options.pluginDir}.\n`);
      } else {
        output.write(`Linked plugin to ${options.pluginDir}.\n`);
      }
    }
    output.write("Antigravity setup complete. Start a new Antigravity session to use the updated instruction.\n");
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
    console.error(`Antigravity setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
