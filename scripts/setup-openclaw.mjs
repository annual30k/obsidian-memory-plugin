import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigs } from "../lib/config.js";
import { validateVaultPath } from "./setup-codex.mjs";

export const PLUGIN_ID = "obsidian-memory-plugin";
const ENTRY_PATH = `plugins.entries.${PLUGIN_ID}`;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

function parseArgs(args) {
  const options = { bin: "openclaw", confirm: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--vault", "--agent", "--openclaw-bin"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      options[{ "--vault": "vaultPath", "--agent": "agentId", "--openclaw-bin": "bin" }[arg]] = value;
    } else if (arg === "--yes") options.confirm = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new TypeError(`Unknown option: ${arg}`);
  }
  return options;
}

function invoke(run, bin, args) {
  const result = run(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new TypeError(`Could not run OpenClaw: ${result.error.message}`);
  return result;
}

function readJson(run, bin, args, { optional = false } = {}) {
  const result = invoke(run, bin, args);
  let data;
  try { data = JSON.parse(result.stdout); }
  catch { throw new TypeError(`OpenClaw returned invalid JSON for ${args.slice(0, 2).join(" ")}`); }
  if (result.status === 0) return data;
  if (optional && data?.error?.message?.includes("valid but unset")) return undefined;
  throw new TypeError(`OpenClaw could not read ${args.slice(0, 2).join(" ")}`);
}

export function buildEntry(previous, agentId, vaultPath) {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    throw new TypeError("OpenClaw plugin entry must be an object");
  }
  const oldConfig = previous.config ?? {};
  const existing = parseConfigs(oldConfig);
  const agentConfigs = Object.fromEntries([...existing].map(([id, config]) => {
    const { agentId: _ignored, ...connection } = config;
    return [id, connection];
  }));
  agentConfigs[agentId] = { ...(agentConfigs[agentId] ?? {}), vaultPath };
  return {
    ...previous,
    enabled: true,
    hooks: {
      ...(previous.hooks ?? {}),
      allowConversationAccess: true,
      allowPromptInjection: true
    },
    config: { agentConfigs }
  };
}

function setValue(run, bin, path, value, previous, dryRun) {
  const args = ["config", "set", path, JSON.stringify(value), "--strict-json"];
  if (dryRun) args.push("--dry-run");
  else if (previous === undefined) args.push("--expect-current-absent");
  else args.push("--expect-current-json", JSON.stringify(previous));
  const result = invoke(run, bin, args);
  if (result.status !== 0) throw new TypeError(`OpenClaw rejected the ${path} update; no existing value was overwritten`);
}

export async function runSetup(args, { input = process.stdin, output = process.stdout, run = spawnSync } = {}) {
  const options = parseArgs(args);
  if (options.help) {
    output.write("Usage: node scripts/setup-openclaw.mjs [--vault <absolute-path>] [--agent <id>] [--yes] [--dry-run]\n" +
      "Select an existing Vault and OpenClaw agent; safely merge this plugin's settings. --yes requires --vault and --agent.\n");
    return;
  }
  if (options.confirm && (!options.vaultPath || !options.agentId)) {
    throw new TypeError("--yes requires explicit --vault and --agent values");
  }
  const prompt = createInterface({ input, output });
  try {
    const vaultPath = validateVaultPath(options.vaultPath ?? await prompt.question("Existing Obsidian Vault absolute path: "));
    const suppliedAgent = options.agentId ?? await prompt.question("OpenClaw agent ID [main]: ");
    const agentId = options.agentId === undefined && !suppliedAgent.trim() ? "main" : suppliedAgent.trim();
    if (agentId.length > 128 || !AGENT_ID.test(agentId)) throw new TypeError("Invalid OpenClaw agent ID");
    const agents = readJson(run, options.bin, ["agents", "list", "--json"]);
    if (!Array.isArray(agents) || !agents.some(agent => agent?.id === agentId)) {
      throw new TypeError(`OpenClaw agent ${agentId} does not exist`);
    }
    const previous = readJson(run, options.bin, ["config", "get", ENTRY_PATH, "--json"], { optional: true });
    const next = buildEntry(previous ?? {}, agentId, vaultPath);
    const oldAllow = readJson(run, options.bin, ["config", "get", "plugins.allow", "--json"], { optional: true });
    if (oldAllow !== undefined && (!Array.isArray(oldAllow) || !oldAllow.every(item => typeof item === "string"))) {
      throw new TypeError("plugins.allow is not a string list; inspect it before setup");
    }
    const nextAllow = oldAllow && !oldAllow.includes(PLUGIN_ID) ? [...oldAllow, PLUGIN_ID] : null;
    setValue(run, options.bin, ENTRY_PATH, next, previous, true);
    if (nextAllow) setValue(run, options.bin, "plugins.allow", nextAllow, oldAllow, true);
    if (options.dryRun) {
      output.write(`Dry run passed. Would enable ${PLUGIN_ID} for ${agentId} with Vault ${vaultPath}` +
        `${nextAllow ? " and extend plugins.allow" : ""}. No configuration changed.\n`);
      return;
    }
    if (!options.confirm) {
      const answer = await prompt.question(`Enable Obsidian Memory for ${agentId} using ${vaultPath}? [y/N] `);
      if (!/^(y|yes)$/i.test(answer.trim())) {
        output.write("No configuration changed.\n");
        return;
      }
    }
    setValue(run, options.bin, ENTRY_PATH, next, previous, false);
    if (nextAllow) setValue(run, options.bin, "plugins.allow", nextAllow, oldAllow, false);
    output.write(`Configured ${PLUGIN_ID} for ${agentId}. Restart the OpenClaw Gateway and verify the skill is visible.\n`);
  } finally {
    prompt.close();
  }
}

const isEntrypoint = process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runSetup(process.argv.slice(2)).catch(error => {
    console.error(`OpenClaw setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
