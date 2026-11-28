/**
 * The mechanical half of an ingest, done by code so every machine produces the same bytes
 * (`omem ingest freeze` / `omem ingest complete`). The agent keeps the half that needs judgement:
 * comparing the evidence with existing knowledge and writing Wiki, index and log.
 *
 *   freeze    inbox/<cand>.md  ->  raw/raw-<cand>.md (+ attachments copied to raw/assets/<cand>/)
 *             The Raw note is a pure function of the candidate: same candidate, same bytes, on any
 *             machine, host or model. Its `created` and `captured_at` are the candidate's creation time;
 *             when and where it was frozen goes in the ingest log entry, not in Raw.
 *   complete  after the agent's Wiki/index/log work: checks the Raw still matches the candidate and the
 *             scope's log carries `ingest_id: ingest-<cand>`, then sets the candidate's
 *             `status: ingested` and `raw_record` (again the same bytes everywhere).
 *
 * A Raw that already exists is never rewritten: if it is not what freeze would write, freeze reports a
 * blocker (Skill: mismatched evidence is never overwritten). Candidates that are not standard (no id,
 * id not matching the file, missing core fields, wrong scope) are refused with the reason, for the
 * agent and the user to decide.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsSensitiveContent } from "./memory-router/fast-path.js";
import { parseFrontmatter } from "./memory-router/vault-index.js";
import { normalizeEol } from "./vault-templates.js";

const CAND_ID = /^cand-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REQUIRED = ["schema_version", "id", "title", "type", "scope", "project_id", "status", "created", "sensitivity", "source_ref"];
// Body sections of a candidate that are not evidence: they describe links to derived notes.
const NOT_EVIDENCE = /^(?:Related canonical notes|Related notes|Related|Ingest state)$/iu;

// The Raw layout below is format 1. Machines must produce the same bytes, so it never changes in place:
// a new layout gets a new format name, and import compares older Raw notes by their evidence instead.
export const FREEZE_FORMAT = "omem-ingest/1";

const q = (v) => JSON.stringify(String(v ?? ""));
const toPosix = (p) => p.split(path.sep).join("/");

/** This machine's name for ingest log entries (`ingested_on`). */
export function deviceName() {
  return (process.env.OBSIDIAN_MEMORY_DEVICE?.trim() || os.hostname().replace(/\.local$/iu, "")).slice(0, 64);
}

/** Every candidate file of the Vault by id: { id: { abs, rel, scopeRel } } (inbox/ and inbox/archive/). */
export function findCandidates(vaultPath) {
  const scopes = [];
  if (fs.existsSync(path.join(vaultPath, "10-Global"))) scopes.push("10-Global");
  try {
    for (const p of fs.readdirSync(path.join(vaultPath, "20-Projects"))) {
      if (!p.startsWith(".") && fs.statSync(path.join(vaultPath, "20-Projects", p)).isDirectory()) scopes.push(`20-Projects/${p}`);
    }
  } catch {}
  const out = {};
  const scan = (dir, scopeRel, depth) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isDirectory() && depth < 2 && (name === "archive" || depth === 1)) scan(abs, scopeRel, depth + 1);
      else if (st.isFile() && /^cand-.*\.md$/u.test(name)) {
        const id = name.slice(0, -3);
        out[id] ??= { abs, rel: toPosix(path.relative(vaultPath, abs)), scopeRel };
      }
    }
  };
  for (const s of scopes) scan(path.join(vaultPath, ...s.split("/"), "inbox"), s, 0);
  return out;
}

function sections(body) {
  const parts = [];
  let current = { heading: null, lines: [] };
  for (const line of body.split("\n")) {
    const h = /^##[ \t]+(.+?)[ \t]*$/u.exec(line);
    if (h) { parts.push(current); current = { heading: h[1], lines: [] }; continue; }
    current.lines.push(line);
  }
  parts.push(current);
  return parts;
}

function listValue(text, key) {
  const fm = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? "";
  const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, "mu").exec(fm);
  if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/gu, "")).filter(Boolean);
  const block = new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-[^\\n]*\\n?)*)`, "mu").exec(fm);
  if (!block) return [];
  return block[1].split("\n").map((l) => /^[ \t]+-\s*(.+)$/u.exec(l)?.[1]?.trim().replace(/^["']|["']$/gu, "")).filter(Boolean);
}

/**
 * Read and check one candidate. Returns { ok, error?, cand } where cand = { id, abs, rel, scopeRel,
 * data, text, body, attachments: [{ from, to, fromRel, toRel }] }.
 */
export function readCandidate(vaultPath, idOrPath) {
  let found;
  if (CAND_ID.test(idOrPath)) {
    found = findCandidates(vaultPath)[idOrPath];
    if (!found) return { ok: false, error: `candidate ${idOrPath} not found in any inbox` };
  } else {
    const abs = path.resolve(vaultPath, idOrPath);
    const rel = toPosix(path.relative(vaultPath, abs));
    const m = /^(10-Global|20-Projects\/[^/]+)\/inbox\/(?:archive\/[^/]+\/)?(cand-[^/]+)\.md$/u.exec(rel);
    if (!m || !fs.existsSync(abs)) return { ok: false, error: `${idOrPath} is not a candidate file in an inbox` };
    found = { abs, rel, scopeRel: m[1] };
  }
  const id = path.basename(found.abs, ".md");
  const text = normalizeEol(fs.readFileSync(found.abs, "utf8"));
  const { data, body } = parseFrontmatter(text);
  const problems = [];
  if (!CAND_ID.test(id)) problems.push(`file name ${id} is not cand-<uuid>`);
  if (data.id !== id) problems.push(`id ${data.id ?? "(none)"} does not match the file name`);
  for (const k of REQUIRED) if (!(k in data)) problems.push(`no ${k}`);
  const expectScope = found.scopeRel === "10-Global" ? "global" : "project";
  if (data.scope && data.scope !== expectScope) problems.push(`scope ${data.scope} but the file is under ${found.scopeRel}`);
  if (expectScope === "project" && data.project_id && data.project_id !== found.scopeRel.slice("20-Projects/".length)) problems.push(`project_id ${data.project_id} does not match ${found.scopeRel}`);
  if (data.status && !["pending-ingest", "ingested"].includes(data.status)) problems.push(`status ${data.status}`);
  if (containsSensitiveContent(text)) problems.push("contains what looks like a credential");
  const attachments = [];
  for (const link of listValue(text, "attachments")) {
    const target = link.replace(/^\[\[|\]\]$/gu, "").split("|")[0];
    const prefix = `${found.scopeRel}/inbox/assets/${id}/`;
    if (!target.startsWith(prefix) || target.slice(prefix.length).includes("..")) { problems.push(`attachment ${target} is not under ${prefix}`); continue; }
    const name = target.slice(prefix.length);
    const from = path.join(vaultPath, ...target.split("/"));
    if (!fs.existsSync(from)) { problems.push(`attachment ${target} is missing`); continue; }
    const toRel = `${found.scopeRel}/raw/assets/${id}/${name}`;
    attachments.push({ from, fromRel: target, to: path.join(vaultPath, ...toRel.split("/")), toRel });
  }
  const cand = { id, ...found, data, text, body, attachments };
  return problems.length ? { ok: false, error: problems.join("; "), cand } : { ok: true, cand };
}

/** The Raw note for a candidate: a pure function of the candidate's text and location. */
export function renderRaw(cand) {
  const d = cand.data;
  const rawAttachments = cand.attachments.map((a) => `  - ${q(`[[${a.toRel}]]`)}`);
  const fm = [
    "---",
    "schema_version: 1",
    `id: ${q(`raw-${cand.id}`)}`,
    `candidate_id: ${q(cand.id)}`,
    `title: ${q(d.title)}`,
    "type: raw-task-record",
    `scope: ${q(d.scope)}`,
    `project_id: ${d.scope === "project" && d.project_id && d.project_id !== "null" ? q(d.project_id) : "null"}`,
    "status: frozen",
    `created: ${q(d.created)}`,
    `captured_at: ${q(d.created)}`,
    `sensitivity: ${q(d.sensitivity)}`,
    `source_ref: ${q(d.source_ref)}`,
    rawAttachments.length ? `attachments:\n${rawAttachments.join("\n")}` : "attachments: []",
    `source_candidate: ${q(`[[${cand.scopeRel}/inbox/${cand.id}]]`)}`,
    `frozen_by: ${FREEZE_FORMAT}`,
    "---"
  ];
  // Evidence verbatim: every section of the candidate except the ones that point at derived notes,
  // with candidate links to its own assets pointing at the frozen copies.
  const kept = sections(normalizeEol(cand.body))
    .filter((s) => s.heading === null || !NOT_EVIDENCE.test(s.heading))
    .map((s) => (s.heading === null ? s.lines.filter((l) => !/^#[ \t]/u.test(l)).join("\n") : `## ${s.heading}\n${s.lines.join("\n")}`))
    .join("\n")
    .replaceAll(`${cand.scopeRel}/inbox/assets/${cand.id}/`, `${cand.scopeRel}/raw/assets/${cand.id}/`)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const hasSource = /^##[ \t]+Source(?: reference)?[ \t]*$/imu.test(kept);
  return `${fm.join("\n")}\n\n# ${d.title}\n\n${hasSource ? "" : `## Source reference\n\n${d.source_ref}\n\n`}${kept}\n`;
}

export const rawRel = (cand) => `${cand.scopeRel}/raw/raw-${cand.id}.md`;

/**
 * Plan (and with apply: write) freezing candidates. Returns per candidate
 * { id, state: "frozen" | "already" | "blocked" | "refused", raw, attachments, error? }.
 */
export function freezeCandidates(vaultPath, ids, { apply = false } = {}) {
  return ids.map((idOrPath) => {
    const r = readCandidate(vaultPath, idOrPath);
    if (!r.ok) return { id: idOrPath, state: "refused", error: r.error };
    const cand = r.cand;
    const raw = rawRel(cand);
    const rawAbs = path.join(vaultPath, ...raw.split("/"));
    const text = renderRaw(cand);
    const existing = fs.existsSync(rawAbs) ? normalizeEol(fs.readFileSync(rawAbs, "utf8")) : null;
    const assetIssues = cand.attachments.filter((a) => fs.existsSync(a.to) && !fs.readFileSync(a.to).equals(fs.readFileSync(a.from)));
    if (assetIssues.length) return { id: cand.id, state: "blocked", raw, error: `frozen attachment differs: ${assetIssues.map((a) => a.toRel).join(", ")}` };
    if (existing !== null && existing !== text) {
      return { id: cand.id, state: "blocked", raw, error: `${raw} exists and is not this candidate's freeze (written by hand or the candidate changed); Raw is never overwritten` };
    }
    const missingAssets = cand.attachments.filter((a) => !fs.existsSync(a.to));
    if (existing !== null && !missingAssets.length) return { id: cand.id, state: "already", raw, attachments: cand.attachments.map((a) => a.toRel) };
    if (apply) {
      for (const a of missingAssets) { fs.mkdirSync(path.dirname(a.to), { recursive: true }); fs.copyFileSync(a.from, a.to); }
      if (existing === null) {
        fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
        fs.writeFileSync(rawAbs, text, { flag: "wx" });
      }
    }
    return { id: cand.id, state: "frozen", raw, attachments: cand.attachments.map((a) => a.toRel) };
  });
}

/** Set `key: value` in a frontmatter block (replacing the key's line, or appending it). */
function setFrontmatter(text, key, value) {
  const m = /^---\n([\s\S]*?)\n---/u.exec(text);
  if (!m) return text;
  const re = new RegExp(`^${key}:.*$`, "mu");
  const head = re.test(m[1]) ? m[1].replace(re, `${key}: ${value}`) : `${m[1]}\n${key}: ${value}`;
  return `---\n${head}\n---${text.slice(m[0].length)}`;
}

/**
 * Plan (and with apply: write) completing candidates after the agent's synthesis. Requires the frozen
 * Raw (unchanged) and the scope log's `ingest_id: ingest-<cand>` marker. Returns per candidate
 * { id, state: "completed" | "already" | "blocked" | "refused", error?, citedBy }.
 */
export function completeCandidates(vaultPath, ids, { apply = false } = {}) {
  return ids.map((idOrPath) => {
    const r = readCandidate(vaultPath, idOrPath);
    if (!r.ok) return { id: idOrPath, state: "refused", error: r.error };
    const cand = r.cand;
    const raw = rawRel(cand);
    const rawAbs = path.join(vaultPath, ...raw.split("/"));
    if (!fs.existsSync(rawAbs)) return { id: cand.id, state: "blocked", error: `${raw} does not exist; run omem ingest freeze first` };
    const log = (() => { try { return fs.readFileSync(path.join(vaultPath, ...cand.scopeRel.split("/"), "log.md"), "utf8"); } catch { return ""; } })();
    if (!new RegExp(`ingest_id:\\s*ingest-${cand.id}\\b`, "u").test(log)) {
      return { id: cand.id, state: "blocked", error: `${cand.scopeRel}/log.md has no "ingest_id: ingest-${cand.id}" entry yet` };
    }
    const citedBy = citingNotes(vaultPath, cand.scopeRel, `raw-${cand.id}`);
    const link = q(`[[${cand.scopeRel}/raw/raw-${cand.id}]]`);
    let next = setFrontmatter(cand.text, "status", "ingested");
    next = setFrontmatter(next, "raw_record", link);
    if (next === cand.text) return { id: cand.id, state: "already", citedBy };
    if (apply) {
      const tmp = `${cand.abs}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, cand.abs);
    }
    return { id: cand.id, state: "completed", citedBy };
  });
}

/** Derived notes of a scope (wiki/, checkpoints/, preferences) whose text links to a Raw note. */
export function citingNotes(vaultPath, scopeRel, rawId) {
  const out = [];
  const root = path.join(vaultPath, ...scopeRel.split("/"));
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs);
      else if (name.endsWith(".md") && fs.readFileSync(abs, "utf8").includes(rawId)) out.push(toPosix(path.relative(vaultPath, abs)));
    }
  };
  for (const sub of ["wiki", "checkpoints"]) walk(path.join(root, sub));
  const pref = path.join(root, "preferences.md");
  if (fs.existsSync(pref) && fs.readFileSync(pref, "utf8").includes(rawId)) out.push(`${scopeRel}/preferences.md`);
  return out;
}
