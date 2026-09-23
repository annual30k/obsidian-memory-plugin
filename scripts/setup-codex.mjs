import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

export function defaultHooksPath(codexHome = resolve(homedir(), ".codex")) {
  return resolve(codexHome, "hooks.json");
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

export function buildCodexHookCommand(scriptPath) {
  assertSafeHookScriptPath(scriptPath);
  const safePath = formatWindowsSafePath(scriptPath);
  return `node "${safePath}"`;
}

export function buildCodexHooksConfig(scriptPath) {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: buildCodexHookCommand(scriptPath),
              timeout: HOST_HOOK_TIMEOUT_SECONDS
            }
          ]
        }
      ]
    }
  };
}

export function mergeCodexHooks(existingConfig = {}, pluginHooksConfig = {}) {
  const merged = { ...existingConfig };
  merged.hooks = { ...(merged.hooks || {}) };

  for (const [event, newMatchers] of Object.entries(pluginHooksConfig.hooks || {})) {
    if (!Array.isArray(newMatchers)) continue;
    const existingMatchers = Array.isArray(merged.hooks[event]) ? [...merged.hooks[event]] : [];

    for (const newMatcher of newMatchers) {
      const newInnerHooks = Array.isArray(newMatcher.hooks) ? newMatcher.hooks : [];
      let foundMatchingContainer = false;

      for (const existingMatcher of existingMatchers) {
        if (Array.isArray(existingMatcher.hooks)) {
          const hasHook = existingMatcher.hooks.some(h =>
            typeof h?.command === "string" && h.command.includes("codex-hook.mjs")
          );
          if (hasHook) {
            existingMatcher.hooks = existingMatcher.hooks.map(h =>
              typeof h?.command === "string" && h.command.includes("codex-hook.mjs")
                ? newInnerHooks.find(nh => nh.command?.includes("codex-hook.mjs")) || h
                : h
            );
            foundMatchingContainer = true;
            break;
          }
        }
      }

      if (!foundMatchingContainer) {
        existingMatchers.push(newMatcher);
      }
    }
    merged.hooks[event] = existingMatchers;
  }

  return merged;
}

function parseArgs(args) {
  const options = {
    agentsPath: defaultAgentsPath(),
    hooksPath: defaultHooksPath(),
    configureHooks: false, // Default: false (plugin-bundled hooks/hooks.json is the primary source; opt-in with --hooks)
    confirm: false,
    dryRun: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vault" || arg === "--agents-file" || arg === "--hooks-file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      if (arg === "--vault") options.vaultPath = value;
      else if (arg === "--agents-file") options.agentsPath = value;
      else if (arg === "--hooks-file") options.hooksPath = value;
      index += 1;
    } else if (arg === "--hooks") {
      options.configureHooks = true;
    } else if (arg === "--no-hooks") {
      options.configureHooks = false;
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
  console.log(`Usage: node scripts/setup-codex.mjs [--vault <absolute-path>] [--hooks] [--yes] [--dry-run]

Prompts for an Obsidian Vault path, validates that it is readable, then safely
adds this plugin's managed block to the active global AGENTS file (AGENTS.override.md
when non-empty, otherwise AGENTS.md). --yes requires --vault.
Use --agents-file <absolute-path> only to target a different AGENTS file.
Use --hooks to explicitly configure standalone global hooks in ~/.codex/hooks.json
(default is false; Codex plugin-bundled hooks/hooks.json is the primary source to prevent duplicate execution).`);
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
    output.write(`Configured Obsidian Memory in ${agentsPath}.\n`);

    if (options.configureHooks) {
      const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
      const hookScript = resolve(packageRoot, "scripts", "codex-hook.mjs");
      const hooksPath = options.hooksPath;
      let existingHooks = {};
      if (existsSync(hooksPath)) {
        try {
          existingHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
        } catch {}
      }
      const pluginHooks = buildCodexHooksConfig(hookScript);
      const merged = mergeCodexHooks(existingHooks, pluginHooks);
      mkdirSync(dirname(hooksPath), { recursive: true });
      writeFileSync(hooksPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
      output.write(`Configured native pre-invocation hook in ${hooksPath}.\n`);
    }
    output.write("Start a new Codex task to use the updated instruction.\n");
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
