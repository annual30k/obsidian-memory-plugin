/**
 * The Vault's note templates (00-System/templates/), managed by code so every machine, host and model
 * ends up with byte-identical files. Before this, initialization asked the agent to copy the templates,
 * and an agent could paraphrase them or write its own set; the Skill then kept using whatever was there.
 *
 * Each of the 14 bundled templates in a Vault is one of:
 *   current       identical to this plugin's template (line endings ignored)
 *   outdated      identical to the template of an older plugin version: never edited, safe to upgrade
 *   custom        edited or hand-written, but it has every core field this template must carry
 *   incompatible  edited or hand-written and missing core fields (or with broken frontmatter): notes
 *                 created from it miss fields the Skill, Lint and the digest rely on
 *   missing       not in the Vault
 * lib/template-hashes.json holds every released version's fingerprints (scripts/build-template-hashes.mjs).
 * Templates the plugin does not ship are left alone. Notes are never changed here.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_DIR_REL = "skills/obsidian-memory/assets/templates";
export const VAULT_TEMPLATE_DIR = "00-System/templates";
export const TEMPLATE_BACKUP_DIR = "00-System/template-backups";

const BUNDLED_DIR = fileURLToPath(new URL(`../${TEMPLATE_DIR_REL}/`, import.meta.url));

const CANDIDATE = ["schema_version", "id", "title", "type", "scope", "project_id", "status", "created", "sensitivity", "source_ref"];
const DERIVED = ["title", "type", "scope", "project_id", "status", "deprecated", "created", "last_updated", "sensitivity", "sources"];

/** Frontmatter keys each template must carry (references/templates.md "Core frontmatter fields"). */
export const REQUIRED_FIELDS = Object.freeze({
  "checkpoint.md": DERIVED,
  "credential-reference.md": CANDIDATE,
  "decision.md": DERIVED,
  "global-index.md": ["type", "scope"],
  "global-log.md": ["type", "scope"],
  "global-preferences.md": ["title", "type", "scope", "status", "created", "last_updated", "sensitivity", "sources"],
  "inbox-memory-candidate.md": CANDIDATE,
  "knowledge.md": DERIVED,
  "pitfall.md": DERIVED,
  "project-agent.md": ["type", "project_id"],
  "project-index.md": ["type", "project_id"],
  "project-log.md": ["type", "project_id"],
  "project-rules.md": ["type", "project_id"],
  "raw-task-record.md": ["schema_version", "id", "candidate_id", "title", "type", "scope", "project_id", "status", "created", "captured_at", "sensitivity", "source_ref"]
});

export const TEMPLATE_NAMES = Object.freeze(Object.keys(REQUIRED_FIELDS));

export const normalizeEol = (text) => String(text).replace(/\r\n?/gu, "\n");

export function templateHash(text) {
  return crypto.createHash("sha256").update(normalizeEol(text), "utf8").digest("hex");
}

export function bundledTemplate(name) {
  return normalizeEol(fs.readFileSync(path.join(BUNDLED_DIR, name), "utf8"));
}

let registry = null;
function knownHashes() {
  if (!registry) {
    try { registry = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./template-hashes.json", import.meta.url)), "utf8")); }
    catch { registry = {}; }
  }
  return registry;
}

/**
 * Frontmatter problems of a template text: { keys, problems }. A value that starts with an unquoted
 * "{{" is a YAML mapping, not text ("created: {{date}}" reads as {"{ date }": null}).
 */
export function frontmatterInfo(text) {
  const t = normalizeEol(text);
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(t);
  if (!m) return { keys: [], problems: ["no frontmatter"] };
  const keys = [];
  const problems = [];
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (!kv) continue;
    keys.push(kv[1]);
    if (/^\{\{/u.test(kv[2].trim())) problems.push(`${kv[1]}: unquoted {{…}} placeholder (YAML reads it as an object)`);
  }
  return { keys, problems };
}

/** Classify one template text against this plugin's template of the same name. */
export function classifyTemplate(name, text) {
  if (text === null || text === undefined) return { name, state: "missing", missingFields: [], problems: [] };
  const hash = templateHash(text);
  if (hash === templateHash(bundledTemplate(name))) return { name, state: "current", missingFields: [], problems: [] };
  const versions = knownHashes()[name]?.[hash];
  if (versions?.length) return { name, state: "outdated", versions, missingFields: [], problems: [] };
  const { keys, problems } = frontmatterInfo(text);
  const missingFields = (REQUIRED_FIELDS[name] ?? []).filter((k) => !keys.includes(k));
  return { name, state: missingFields.length || problems.length ? "incompatible" : "custom", missingFields, problems };
}

function readMaybe(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

const vaultFile = (vaultPath, name) => path.join(vaultPath, ...VAULT_TEMPLATE_DIR.split("/"), name);

/** Every bundled template's state in a Vault. */
export function templateStatus(vaultPath) {
  return TEMPLATE_NAMES.map((name) => classifyTemplate(name, readMaybe(vaultFile(vaultPath, name))));
}

export function summarizeStatus(status) {
  const by = (s) => status.filter((t) => t.state === s).map((t) => t.name);
  return { current: by("current"), outdated: by("outdated"), custom: by("custom"), incompatible: by("incompatible"), missing: by("missing") };
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Bring the Vault's templates to this plugin's version. Always: add missing ones and upgrade outdated
 * (never-edited) ones. With replaceCustom: also replace custom and incompatible ones, each first copied
 * to 00-System/template-backups/<time>/. Nothing is written unless apply.
 * Returns { add, upgrade, replace, keep, backupDir, status }.
 */
export function updateTemplates(vaultPath, { apply = false, replaceCustom = false, onlyMissing = false, now = new Date() } = {}) {
  const status = templateStatus(vaultPath);
  const plan = { add: [], upgrade: [], replace: [], keep: [], backupDir: null, status };
  for (const t of status) {
    if (t.state === "missing") plan.add.push(t.name);
    else if (t.state === "current") continue;
    else if (onlyMissing) plan.keep.push(t);
    else if (t.state === "outdated") plan.upgrade.push(t.name);
    else if (replaceCustom) plan.replace.push(t.name);
    else plan.keep.push(t);
  }
  if (plan.replace.length) plan.backupDir = `${TEMPLATE_BACKUP_DIR}/${stamp(now)}`;
  if (apply) {
    for (const name of plan.replace) {
      const backup = path.join(vaultPath, ...plan.backupDir.split("/"), name);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(vaultFile(vaultPath, name), backup);
    }
    for (const name of [...plan.add, ...plan.upgrade, ...plan.replace]) writeAtomic(vaultFile(vaultPath, name), bundledTemplate(name));
  }
  return plan;
}

/** One line for setup scripts and doctor-like reports, or null when every template is current. */
export function templateNotice(vaultPath) {
  if (!fs.existsSync(path.join(vaultPath, ...VAULT_TEMPLATE_DIR.split("/")))) return null;
  const s = summarizeStatus(templateStatus(vaultPath));
  const parts = [];
  if (s.incompatible.length) parts.push(`${s.incompatible.length} lack core fields (${s.incompatible.join(", ")})`);
  if (s.outdated.length) parts.push(`${s.outdated.length} from an older plugin version`);
  if (s.missing.length) parts.push(`${s.missing.length} missing`);
  if (!parts.length) return null;
  return `Vault templates: ${parts.join("; ")}. Run 'omem templates' to see them and 'omem templates update' to fix them.`;
}
