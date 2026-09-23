import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { HOST_HOOK_TIMEOUT_SECONDS } from "../lib/config.js";
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

export function defaultHooksPath(geminiHome = resolve(homedir(), ".gemini")) {
  return resolve(geminiHome, "hooks.json");
}

export function defaultPluginInstallDir(geminiConfigHome = resolve(homedir(), ".gemini", "config", "plugins")) {
  return resolve(geminiConfigHome, "obsidian-memory-plugin");
}

const UNSAFE_HOOK_PATH_CHARS = /[%!$`"\r\n\0\x00-\x1f\x7f]/;

export function assertSafeHookScriptPath(scriptPath) {
  if (!scriptPath || typeof scriptPath !== "string") {
    throw new TypeError("Hook scriptPath must be a non-empty string");
  }
  if (UNSAFE_HOOK_PATH_CHARS.test(scriptPath)) {
    throw new Error(
      "Invalid hook scriptPath: path contains unsafe shell expansion, substitution, quote, or control characters"
    );
  }
  return scriptPath;
}

export function formatWindowsSafePath(filePath) {
  if (!filePath) return "";
  let normalized = String(filePath).replace(/\\/g, "/");
  if (/^\/[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

export function buildAntigravityHookCommand(scriptPath) {
  assertSafeHookScriptPath(scriptPath);
  const safePath = formatWindowsSafePath(scriptPath);
  return `node "${safePath}"`;
}

export function buildAntigravityHooksConfig(scriptPath) {
  return {
    "obsidian-memory-router": {
      "PreInvocation": [
        {
          "type": "command",
          "command": buildAntigravityHookCommand(scriptPath),
          "timeout": HOST_HOOK_TIMEOUT_SECONDS
        }
      ]
    }
  };
}

export function mergeAntigravityHooks(existingConfig = {}, pluginHooksConfig = {}) {
  const merged = { ...existingConfig };
  for (const [key, value] of Object.entries(pluginHooksConfig)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      merged[key] = { ...(merged[key] || {}), ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
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
    hooksPath: defaultHooksPath(),
    configureHooks: false, // Default: false (plugin-bundled hooks.json is primary; opt-in with --hooks)
    link: true,
    confirm: false,
    dryRun: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vault" || arg === "--gemini-file" || arg === "--plugin-dir" || arg === "--hooks-file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      if (arg === "--vault") options.vaultPath = value;
      else if (arg === "--gemini-file") options.geminiPath = value;
      else if (arg === "--plugin-dir") options.pluginDir = value;
      else if (arg === "--hooks-file") options.hooksPath = value;
      index += 1;
    } else if (arg === "--hooks") {
      options.configureHooks = true;
    } else if (arg === "--no-hooks") {
      options.configureHooks = false;
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
  console.log(`Usage: node scripts/setup-antigravity.mjs [--vault <absolute-path>] [--gemini-file <absolute-path>] [--plugin-dir <absolute-path>] [--link|--no-link] [--hooks] [--yes] [--dry-run]

Prompts for an Obsidian Vault path, validates that it is readable, links the plugin
into Antigravity's global plugin directory (~/.gemini/config/plugins/obsidian-memory-plugin),
and safely adds or updates this plugin's managed block in the active global GEMINI.md file.

Options:
  --vault <path>        Absolute physical path of the Obsidian Vault
  --gemini-file <path>  Target GEMINI.md file (default: ~/.gemini/GEMINI.md)
  --plugin-dir <path>   Destination plugin directory (default: ~/.gemini/config/plugins/obsidian-memory-plugin)
  --hooks-file <path>   Target hooks.json file (default: ~/.gemini/hooks.json)
  --hooks / --no-hooks  Whether to configure standalone global hooks in ~/.gemini/hooks.json (default: false; plugin-bundled hooks.json is primary source)
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

    if (options.configureHooks) {
      const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
      const hookScript = resolve(packageRoot, "scripts", "antigravity-hook.mjs");
      const hooksPath = options.hooksPath;
      let existingHooks = {};
      if (existsSync(hooksPath)) {
        try {
          existingHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
        } catch {}
      }
      const pluginHooks = buildAntigravityHooksConfig(hookScript);
      const merged = mergeAntigravityHooks(existingHooks, pluginHooks);
      mkdirSync(dirname(hooksPath), { recursive: true });
      writeFileSync(hooksPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
      output.write(`Configured native pre-invocation hook in ${hooksPath}.\n`);
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
