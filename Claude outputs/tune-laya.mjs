#!/usr/bin/env node
// Runs scripts/tune-laya-questions.py inside the Laya venv (where the model packages live).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDefaultVenvPath, getVenvPython } from "./laya-service.mjs";

const python = getVenvPython(getDefaultVenvPath());
if (!existsSync(python)) {
  process.stderr.write(`Laya venv not found (${python}). Run "npm run laya:install" first.\n`);
  process.exit(2);
}
const script = fileURLToPath(new URL("./tune-laya-questions.py", import.meta.url));
const result = spawnSync(python, ["-B", script, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
});
process.exit(result.status ?? 1);
