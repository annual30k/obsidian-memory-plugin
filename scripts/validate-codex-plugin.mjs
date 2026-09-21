import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, ".codex-plugin", "plugin.json");
const marketplacePath = resolve(root, ".agents", "plugins", "marketplace.json");
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
  failures.push(`cannot read valid JSON from .codex-plugin/plugin.json: ${error.message}`);
}

if (manifest) {
  requireString(manifest.name, "name");
  requireString(manifest.version, "version");
  requireString(manifest.description, "description");
  requireString(manifest.author?.name, "author.name");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
    failures.push("version must use semantic versioning");
  }
  if (typeof manifest.skills !== "string" || !manifest.skills.startsWith("./")) {
    failures.push("skills must be a plugin-relative path");
  } else {
    requireDirectory(resolve(root, manifest.skills), "skills");
  }
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    requireString(manifest.interface?.[field], `interface.${field}`);
  }
  if (!Array.isArray(manifest.interface?.capabilities) || manifest.interface.capabilities.some(value => typeof value !== "string" || !value.trim())) {
    failures.push("interface.capabilities must be an array of non-empty strings");
  }
  if (!Array.isArray(manifest.interface?.defaultPrompt) || manifest.interface.defaultPrompt.length === 0) {
    failures.push("interface.defaultPrompt must be a non-empty array");
  }
  for (const field of ["composerIcon", "logo"]) {
    const assetPath = manifest.interface?.[field];
    if (typeof assetPath !== "string" || !assetPath.startsWith("./")) {
      failures.push(`interface.${field} must be a plugin-relative path`);
      continue;
    }
    const resolvedAsset = resolve(root, assetPath);
    if (!existsSync(resolvedAsset) || !statSync(resolvedAsset).isFile()) {
      failures.push(`interface.${field} must point to an existing file`);
      continue;
    }
    const png = readFileSync(resolvedAsset);
    const isPng = png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const width = isPng ? png.readUInt32BE(16) : 0;
    const height = isPng ? png.readUInt32BE(20) : 0;
    if (!isPng || width !== 512 || height !== 512) {
      failures.push(`interface.${field} must point to a 512x512 PNG`);
    }
  }
  if (JSON.stringify(manifest).includes("[TODO:")) failures.push("manifest contains an unfinished TODO placeholder");
}

let marketplace;
try {
  marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
} catch (error) {
  failures.push(`cannot read valid JSON from .agents/plugins/marketplace.json: ${error.message}`);
}
if (marketplace) {
  requireString(marketplace.name, "marketplace.name");
  const entry = marketplace.plugins?.find(plugin => plugin.name === manifest?.name);
  if (!entry) {
    failures.push("marketplace must list the Codex plugin");
  } else {
    if (entry.source?.source !== "url" || entry.source?.url !== "https://github.com/annual30k/obsidian-memory-plugin.git") {
      failures.push("marketplace must resolve this repository-root plugin");
    }
    if (entry.policy?.installation !== "AVAILABLE" || entry.policy?.authentication !== "ON_INSTALL") {
      failures.push("marketplace policy must make the plugin available on install");
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Codex manifest and marketplace validation passed: ${manifestPath}`);
}
