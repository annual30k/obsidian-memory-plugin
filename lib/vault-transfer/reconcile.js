/**
 * Import-time reconciliation by candidate identity: two copies of a Vault where the same candidate was
 * ingested on both. Evidence (candidate, Raw) is the same on both sides; only what the agents derived
 * from it differs. These helpers decide what is really the same and what needs a person or agent.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../memory-router/vault-index.js";
import { normalizeEol } from "../vault-templates.js";

export const CANDIDATE_PATH = /^(10-Global|20-Projects\/[^/]+)\/inbox\/(?:archive\/[^/]+\/)?(cand-[^/]+)\.md$/u;
export const RAW_PATH = /^(10-Global|20-Projects\/[^/]+)\/raw\/raw-(cand-[^/]+)\.md$/u;
export const DERIVED_PATH = /^(10-Global|20-Projects\/[^/]+)\/(?:wiki|checkpoints)\/.+\.md$/u;
export const INDEX_PATH = /(?:^|\/)(?:index|index-[^/]+|raw-index)\.md$/u;
const CAND_REF = /raw-(cand-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gu;

// Frontmatter keys that record when or how a note was processed, not what it says.
const CANDIDATE_PROCESS_KEYS = new Set(["status", "raw_record", "last_updated", "ingested_at", "ingested_on", "discarded_at", "archived_at"]);
const RAW_PROCESS_KEYS = new Set(["created", "captured_at", "last_updated", "frozen_by", "template_migrated", "reviewed", "review_status", "immutable"]);

function comparable(text, skipKeys) {
  const t = normalizeEol(text);
  const { data, body } = parseFrontmatter(t);
  const kept = Object.keys(data).filter((k) => !skipKeys.has(k)).sort().map((k) => `${k}=${JSON.stringify(data[k])}`);
  return `${kept.join("\n")}\n---\n${body.replace(/[ \t]+$/gmu, "").replace(/\n{2,}/gu, "\n\n").trim()}`;
}

const STATUS_RANK = { "pending-ingest": 0, pending: 0, ingested: 1, discarded: 1 };

/**
 * The same candidate in both copies: "same" (keep local), "incoming" (the other copy processed it
 * further: take it) or "conflict" (its evidence was edited differently).
 */
export function reconcileCandidate(localText, incomingText) {
  if (comparable(localText, CANDIDATE_PROCESS_KEYS) !== comparable(incomingText, CANDIDATE_PROCESS_KEYS)) return "conflict";
  const rank = (t) => STATUS_RANK[parseFrontmatter(normalizeEol(t)).data.status] ?? 0;
  return rank(incomingText) > rank(localText) ? "incoming" : "same";
}

/** The same Raw note in both copies: "same" when the frozen evidence matches, else "conflict". */
export function reconcileRaw(localText, incomingText) {
  return comparable(localText, RAW_PROCESS_KEYS) === comparable(incomingText, RAW_PROCESS_KEYS) ? "same" : "conflict";
}

/** Candidate ids whose Raw a note links to. */
export function citedCandidates(text) {
  return [...new Set([...String(text).matchAll(CAND_REF)].map((m) => m[1]))];
}

function walkMd(dir, base, out) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isDirectory()) walkMd(abs, base, out);
    else if (name.endsWith(".md")) out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
}

/**
 * What the local Vault already holds, before an import writes anything:
 *   candidates  id -> rel of the candidate file (inbox/ or inbox/archive/)
 *   ingested    ids with a local Raw note (frozen here)
 *   citedBy     id -> local derived notes (wiki/, checkpoints/) linking its Raw
 */
export function localIngestState(vaultPath) {
  const all = [];
  for (const top of ["10-Global", "20-Projects"]) walkMd(path.join(vaultPath, top), vaultPath, all);
  const candidates = {};
  const ingested = new Set();
  const citedBy = {};
  for (const rel of all) {
    const c = CANDIDATE_PATH.exec(rel);
    if (c) { candidates[c[2]] ??= rel; continue; }
    const r = RAW_PATH.exec(rel);
    if (r) { ingested.add(r[2]); continue; }
    if (DERIVED_PATH.test(rel)) {
      let text;
      try { text = fs.readFileSync(path.join(vaultPath, ...rel.split("/")), "utf8"); } catch { continue; }
      for (const id of citedCandidates(text)) (citedBy[id] ??= []).push(rel);
    }
  }
  return { candidates, ingested, citedBy };
}

/** Index lines (with a [[link]]) of `incoming` that point at one of `added` and are not in `local`. */
export function newIndexLines(localText, incomingText, added) {
  const have = new Set(normalizeEol(localText).split("\n").map((l) => l.trim()));
  const targets = new Set(added.map((r) => r.replace(/\.md$/u, "")));
  return normalizeEol(incomingText).split("\n").filter((line) => {
    if (have.has(line.trim())) return false;
    const links = [...line.matchAll(/\[\[([^\]|#]+)/gu)].map((m) => m[1].trim());
    return links.some((l) => targets.has(l) || [...targets].some((t) => t.endsWith(`/${l}`)));
  });
}

// ---------------------------------------------------------------- fold ledger

/**
 * 00-System/reconciliation.jsonl, one JSON object per line, append-only and merged by line on import:
 *   { "folded": "<vault-relative page>", "hash": "<sha256 of its text, LF>", "into": "<page>", "at": "...", "device": "..." }
 * A page written on two machines from the same candidate is folded into one page on whichever machine
 * imports first. The ledger travels with the Vault so the other machine drops its copy (when unchanged)
 * instead of sending it back again, and a re-import does not park an already folded page twice.
 */
export const LEDGER_REL = "00-System/reconciliation.jsonl";
export const SAME_INGEST_DIR = "same-ingest";

export function textHash(text) {
  return crypto.createHash("sha256").update(normalizeEol(String(text)), "utf8").digest("hex");
}

export function parseLedger(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.folded === "string" && typeof e?.hash === "string" && /^[0-9a-f]{64}$/u.test(e.hash)) out.push(e);
    } catch {}
  }
  return out;
}

export const ledgerKey = (rel, hash) => `${rel}@${hash}`;
