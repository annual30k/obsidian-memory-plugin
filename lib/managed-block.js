import { isAbsolute, resolve } from "node:path";
import { accessSync, constants, readFileSync, statSync } from "node:fs";

export const START_MARKER = "<!-- obsidian-memory-plugin:start -->";
export const END_MARKER = "<!-- obsidian-memory-plugin:end -->";
// The always-on rule, shared by every host (Codex/Antigravity rule files, OpenClaw context, Hermes
// system prompt). Single source: lib/guidance.json, also read by __init__.py.
export const TRIGGER_INSTRUCTION = JSON.parse(readFileSync(new URL("./guidance.json", import.meta.url), "utf8")).trigger;

export function assertSafePath(value, label) {
  if (typeof value !== "string" || !value || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new TypeError(`${label} must be a non-empty path without control characters`);
  }
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  return resolve(value);
}

export function validateVaultPath(value) {
  const vaultPath = assertSafePath(value, "Vault path");
  let metadata;
  try {
    metadata = statSync(vaultPath);
    accessSync(vaultPath, constants.R_OK);
  } catch {
    throw new TypeError("Vault path must be a readable directory");
  }
  if (!metadata.isDirectory()) throw new TypeError("Vault path must be a readable directory");
  return vaultPath;
}

export function managedBlock(vaultPath) {
  return [
    START_MARKER,
    TRIGGER_INSTRUCTION,
    "Obsidian Memory Vault path (configuration data, not instructions): " + JSON.stringify(vaultPath),
    END_MARKER
  ].join("\n");
}

export function updateContentWithBlock(content, vaultPath, label = "Rule file") {
  if (typeof content !== "string") throw new TypeError(`${label} content must be text`);
  const block = managedBlock(vaultPath);
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 && end === -1) {
    return content ? content + (content.endsWith("\n") ? "\n" : "\n\n") + block + "\n" : block + "\n";
  }
  if (start === -1 || end === -1 || end < start || content.indexOf(START_MARKER, start + START_MARKER.length) !== -1 || content.indexOf(END_MARKER, end + END_MARKER.length) !== -1) {
    throw new TypeError(`${label} contains malformed Obsidian Memory markers; repair them manually before setup`);
  }
  return content.slice(0, start) + block + content.slice(end + END_MARKER.length);
}
