#!/usr/bin/env node
// Runs scripts/train-laya-head.py inside the Laya venv (where the model packages live).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultVenvPath, getVenvPython, offlineModelEnv } from "./laya-service.mjs";

const python = getVenvPython(getDefaultVenvPath());
if (!existsSync(python)) {
  process.stderr.write(`Laya venv not found (${python}). Run "npm run laya:install" first.\n`);
  process.exit(2);
}
const argv = process.argv.slice(2);
// After writing a head, restart a running service so it loads the new head (skip with --no-restart).
const restart = !argv.includes("--no-restart") && !argv.includes("--dry-run");
const args = argv.filter((a) => a !== "--no-restart");
// Your own head goes to ~/.laya (loaded before the bundled one) unless --out is given.
// `--target durable` trains the durable-statement head for proactive capture (labels with a `durable` field).
const durable = args.includes("durable") && args.includes("--target");
if (!args.includes("--out") && !args.includes("--dry-run")) args.push("--out", join(homedir(), ".laya", durable ? "durable-head.json" : "recall-head.json"));
const script = fileURLToPath(new URL("./train-laya-head.py", import.meta.url));
const result = spawnSync(python, ["-B", script, ...args], {
  stdio: "inherit",
  env: { ...process.env, ...offlineModelEnv(), PYTHONDONTWRITEBYTECODE: "1" }
});
if (result.status === 0 && restart && existsSync(join(homedir(), ".laya", "service.json"))) {
  const service = fileURLToPath(new URL("./laya-service.mjs", import.meta.url));
  process.stdout.write("\nRestarting the Laya service to load the new head...\n");
  spawnSync(process.execPath, [service, "stop"], { stdio: "inherit" });
  const started = spawnSync(process.execPath, [service, "start"], { stdio: "inherit" });
  process.exit(started.status ?? 1);
}
process.exit(result.status ?? 1);
