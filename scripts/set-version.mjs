#!/usr/bin/env node
/**
 * Set the plugin version in every host manifest at once.
 *
 *   npm run version:set -- 0.7.1
 *
 * Each host reads its own manifest, so the version lives in several files:
 *   package.json              npm / OpenClaw install
 *   openclaw.plugin.json      OpenClaw
 *   .codex-plugin/plugin.json Codex
 *   plugin.json               Antigravity, and Hermes' install-time check (Agent Plugins v1)
 *   plugin.yaml               Hermes (native loader)
 * plus the "当前包版本" line in README.md. tests/manifests.test.mjs fails when they disagree.
 */
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const JSON_MANIFESTS = ["package.json", "openclaw.plugin.json", ".codex-plugin/plugin.json", "plugin.json"];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function setVersion(version, root = fileURLToPath(new URL("..", import.meta.url))) {
  if (!SEMVER.test(version ?? "")) throw new TypeError(`Not a semantic version: ${version}`);
  const changed = [];
  const edit = (file, fn) => {
    const path = resolve(root, file);
    const before = readFileSync(path, "utf8");
    const after = fn(before);
    if (after === before) throw new Error(`${file}: version field not found`);
    writeFileSync(path, after);
    changed.push(file);
  };
  // Replace the value in place so key order and formatting stay untouched.
  for (const file of JSON_MANIFESTS) edit(file, (s) => s.replace(/("version"\s*:\s*")[^"]*(")/u, `$1${version}$2`));
  edit("plugin.yaml", (s) => s.replace(/^version:\s*.*$/mu, `version: ${version}`));
  edit("README.md", (s) => s.replace(/当前包版本：`[^`]*`/u, `当前包版本：\`${version}\``)
    .replace(/obsidian-memory-plugin-\d+\.\d+\.\d+[^\s/]*?\.tgz/gu, `obsidian-memory-plugin-${version}.tgz`));
  return changed;
}

const isMain = process.argv[1] && (() => { try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  try {
    const files = setVersion(process.argv[2]);
    process.stdout.write(`Set version ${process.argv[2]} in: ${files.join(", ")}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\nUsage: npm run version:set -- <x.y.z>\n`);
    process.exit(2);
  }
}
