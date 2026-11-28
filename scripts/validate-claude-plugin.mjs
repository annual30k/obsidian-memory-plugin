#!/usr/bin/env node
/**
 * Checks the Claude Code plugin files: .claude-plugin/plugin.json, .claude-plugin/marketplace.json, and the
 * shared hooks/hooks.json (which Claude Code loads on its own and Codex loads through .codex-plugin).
 * Only Node is needed; nothing under ~/.claude is read.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const readJson = (rel) => {
  try { return JSON.parse(readFileSync(resolve(root, rel), "utf8")); } catch (error) { failures.push(`cannot read valid JSON from ${rel}: ${error.message}`); return null; }
};
const requireString = (value, label) => { if (typeof value !== "string" || !value.trim()) failures.push(`${label} must be a non-empty string`); };

const manifest = readJson(".claude-plugin/plugin.json");
const codex = readJson(".codex-plugin/plugin.json");
if (manifest) {
  requireString(manifest.name, "name");
  requireString(manifest.description, "description");
  requireString(manifest.author?.name, "author.name");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.name ?? "")) failures.push("name must be kebab-case");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version ?? "")) failures.push("version must use semantic versioning");
  if (codex && (manifest.name !== codex.name || manifest.version !== codex.version)) failures.push("name and version must match .codex-plugin/plugin.json");
  // Claude Code discovers skills/ and hooks/hooks.json by convention; naming hooks/hooks.json again would only
  // be skipped as a duplicate, and any other hooks file would run in addition to it.
  if ("hooks" in manifest) failures.push("hooks must not be declared: Claude Code loads hooks/hooks.json on its own");
  if (!existsSync(resolve(root, "skills", "obsidian-memory", "SKILL.md"))) failures.push("skills/obsidian-memory/SKILL.md must exist");
}

const marketplace = readJson(".claude-plugin/marketplace.json");
if (marketplace) {
  requireString(marketplace.name, "marketplace.name");
  requireString(marketplace.owner?.name, "marketplace.owner.name");
  const entry = marketplace.plugins?.find((p) => p.name === manifest?.name);
  if (!entry) failures.push("marketplace must list the plugin");
  else if (entry.source !== "./") failures.push('marketplace source must be "./" (this repository root)');
}

const hooks = readJson("hooks/hooks.json");
if (hooks) {
  for (const [event, script] of [["UserPromptSubmit", "codex-hook.mjs"], ["Stop", "codex-stop-hook.mjs"]]) {
    const commands = (hooks.hooks?.[event] ?? []).flatMap((m) => m.hooks ?? []).map((h) => h.command ?? "");
    const ours = commands.filter((c) => c.includes(script));
    if (ours.length !== 1) failures.push(`hooks/hooks.json must run ${script} once for ${event}`);
    // Both hosts substitute ${CLAUDE_PLUGIN_ROOT}; Claude Code does not know Codex's ${PLUGIN_ROOT}.
    for (const c of ours) if (!c.includes("${CLAUDE_PLUGIN_ROOT}/scripts/") || /\$\{PLUGIN_ROOT\}/u.test(c)) failures.push(`${event} hook must use \${CLAUDE_PLUGIN_ROOT}: ${c}`);
    for (const c of ours) {
      const file = /\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/u.exec(c)?.[1];
      if (file && !(existsSync(resolve(root, file)) && statSync(resolve(root, file)).isFile())) failures.push(`${event} hook script missing: ${file}`);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Claude Code manifest, marketplace and hooks validation passed");
}
