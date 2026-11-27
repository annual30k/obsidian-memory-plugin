#!/usr/bin/env node
/**
 * Maintainer tool: rebuild lib/template-hashes.json, the fingerprints of every bundled Vault template in
 * every released version (from the git tags, plus the current working tree as this package's version).
 * `omem templates` uses it to tell an unmodified older template (safe to upgrade) from a customized one.
 * Run after changing anything in skills/obsidian-memory/assets/templates/ (a test fails until you do).
 *
 *   node scripts/build-template-hashes.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATE_DIR_REL, TEMPLATE_NAMES, templateHash } from "../lib/vault-templates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export function buildTemplateHashes() {
  const out = {};
  const add = (name, text, version) => {
    const hash = templateHash(text);
    out[name] ??= {};
    out[name][hash] ??= [];
    if (!out[name][hash].includes(version)) out[name][hash].push(version);
  };
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean)
    .sort((a, b) => a.slice(1).split(".").map(Number).reduce((r, n, i) => r || n - Number(b.slice(1).split(".")[i]), 0));
  for (const tag of tags) {
    for (const name of TEMPLATE_NAMES) {
      try { add(name, git("show", `${tag}:${TEMPLATE_DIR_REL}/${name}`), tag.slice(1)); } catch {}
    }
  }
  // Commits that changed a template between tags (the earliest ones predate the first tag).
  for (const commit of git("log", "--format=%H", "--", TEMPLATE_DIR_REL).split("\n").filter(Boolean)) {
    let label;
    try { label = JSON.parse(git("show", `${commit}:package.json`)).version; } catch { continue; }
    for (const name of TEMPLATE_NAMES) {
      try {
        const text = git("show", `${commit}:${TEMPLATE_DIR_REL}/${name}`);
        if (!out[name]?.[templateHash(text)]) add(name, text, `${label} (pre-release)`);
      } catch {}
    }
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  for (const name of TEMPLATE_NAMES) add(name, fs.readFileSync(path.join(root, TEMPLATE_DIR_REL, name), "utf8"), version);
  const key = (v) => v.replace(/ .*/u, "").split(".").map(Number);
  for (const hashes of Object.values(out)) {
    for (const list of Object.values(hashes)) list.sort((a, b) => key(a).reduce((r, n, i) => r || n - key(b)[i], 0));
  }
  return out;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = path.join(root, "lib", "template-hashes.json");
  fs.writeFileSync(file, JSON.stringify(buildTemplateHashes(), null, 2) + "\n");
  process.stdout.write(`Wrote ${path.relative(root, file)}\n`);
}
