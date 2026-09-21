import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "plugin.json");
const packagePath = resolve(root, "package.json");
const failures = [];

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) failures.push(`${label} must be a non-empty string`);
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) failures.push(`${label} must be an existing directory`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  failures.push(`cannot read valid JSON from plugin.json: ${error.message}`);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(packagePath, "utf8"));
} catch (error) {
  failures.push(`cannot read valid JSON from package.json: ${error.message}`);
}

if (manifest && pkg) {
  requireString(manifest.name, "name");
  requireString(manifest.version, "version");
  requireString(manifest.description, "description");
  requireString(manifest.author?.name, "author.name");
  requireString(manifest.license, "license");

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
    failures.push("version must use semantic versioning");
  }
  if (manifest.version !== pkg.version) {
    failures.push(`version in plugin.json (${manifest.version}) does not match package.json (${pkg.version})`);
  }
  if (manifest.name !== pkg.name) {
    failures.push(`name in plugin.json (${manifest.name}) does not match package.json (${pkg.name})`);
  }
  if (typeof manifest.skills !== "string" || !manifest.skills.startsWith("./")) {
    failures.push("skills must be a plugin-relative path");
  } else {
    requireDirectory(resolve(root, manifest.skills), "skills");
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
    failures.push("keywords must be a non-empty array");
  }
  if (JSON.stringify(manifest).includes("[TODO:")) {
    failures.push("manifest contains an unfinished TODO placeholder");
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Antigravity plugin manifest validation passed: ${manifestPath}`);
}
