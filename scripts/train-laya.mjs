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
const args = process.argv.slice(2);
// Your own head goes to ~/.laya (loaded before the bundled one) unless --out is given.
if (!args.includes("--out") && !args.includes("--dry-run")) args.push("--out", join(homedir(), ".laya", "recall-head.json"));
const script = fileURLToPath(new URL("./train-laya-head.py", import.meta.url));
const result = spawnSync(python, ["-B", script, ...args], {
  stdio: "inherit",
  env: { ...process.env, ...offlineModelEnv(), PYTHONDONTWRITEBYTECODE: "1" }
});
process.exit(result.status ?? 1);
