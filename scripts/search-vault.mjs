#!/usr/bin/env node
/**
 * Read-only, section-aware local Vault search CLI (`laya search`).
 *
 * Searches the scoped Vault index (lexical + optional Laya semantic embeddings over section chunks),
 * skips deprecated notes by default unless `--include-deprecated` is set, and localizes each hit to its
 * best matching `##` section with 1-based line numbers for targeted reads.
 */
import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { memoryJudgeFromEnv } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";
import {
  loadVaultIndex, loadEmbeddingCache, ensureVaultEmbeddings, mentionedProjectIds,
  resolveProjectIdFromCwd, resolveVaultPath, defaultIndexCachePath, defaultEmbeddingCachePath,
  tokenizeWithPositions, stripCodeLike, extractNoteSections, parseFrontmatter, isVector
} from "../lib/memory-router/vault-index.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SNIPPET_CHARS = 220;
const MAX_READ_BYTES = 65536;
// Body words count less than a title or heading word; the query appearing verbatim counts like grep would.
const BODY_WEIGHT = 0.2;
const PHRASE_BONUS = 4;
// A hook embeds at most one batch per turn; a search the user waits for fills the whole cache at once.
const BACKFILL_BUDGET_MS = 20000;

async function backfillEmbeddings(index, cache, embedPassages, cachePath) {
  const deadline = Date.now() + BACKFILL_BUDGET_MS;
  while (Date.now() < deadline) {
    const { embedded, pending } = await ensureVaultEmbeddings(index, cache, embedPassages, { cachePath, maxNotes: 32 });
    if (!pending || !embedded) break;
  }
}

export function parseArgs(argv = []) {
  const opts = {
    query: "",
    vaultPath: null,
    projectId: null,
    cwd: process.cwd(),
    scope: "project",
    limit: DEFAULT_LIMIT,
    includeDeprecated: false,
    includePending: true,
    semantic: true,
    json: false,
    help: false
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && i + 1 < argv.length) opts.vaultPath = argv[++i];
    else if ((a === "--project" || a === "--project-id") && i + 1 < argv.length) opts.projectId = argv[++i];
    else if (a === "--cwd" && i + 1 < argv.length) opts.cwd = argv[++i];
    else if (a === "--scope" && i + 1 < argv.length) opts.scope = argv[++i];
    else if (a === "--limit" && i + 1 < argv.length) opts.limit = Number(argv[++i]);
    else if ((a === "--query" || a === "-q") && i + 1 < argv.length) opts.query = argv[++i];
    else if (a === "--include-deprecated") opts.includeDeprecated = true;
    else if (a === "--no-pending") opts.includePending = false;
    else if (a === "--no-semantic") opts.semantic = false;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (!opts.query && positional.length > 0) opts.query = positional.join(" ");
  if (!["project", "global", "all"].includes(opts.scope)) opts.scope = "project";
  if (!Number.isFinite(opts.limit) || opts.limit < 1) opts.limit = DEFAULT_LIMIT;
  opts.limit = Math.min(MAX_LIMIT, Math.floor(opts.limit));
  return opts;
}

function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function uniqueQueryTokens(text, projectId = null) {
  const ownWords = new Set(projectId ? tokenizeWithPositions(String(projectId).replace(/-[0-9a-f]{8}$/iu, "")).map((t) => t.token) : []);
  const out = [];
  const seen = new Set();
  for (const t of tokenizeWithPositions(stripCodeLike(text))) {
    if (seen.has(t.token) || ownWords.has(t.token)) continue;
    seen.add(t.token);
    out.push(t);
  }
  return out;
}

function lexicalScore(terms, queryTokens, idf) {
  if (queryTokens.length === 0 || !terms) return 0;
  const concepts = [];
  let current = null;
  for (const t of queryTokens) {
    if (!terms[t.token]) {
      if (t.cjk) current = null;
      continue;
    }
    const weight = idf(t.token) * (terms[t.token] >= 2 ? 1.3 : 1);
    if (t.cjk && current && current.run === t.run && current.last === t.pos - 1) {
      current.weights.push(weight);
      current.last = t.pos;
    } else {
      current = t.cjk ? { run: t.run, last: t.pos, weights: [weight] } : null;
      concepts.push(current ?? { weights: [weight] });
    }
  }
  if (concepts.length === 0) return 0;
  let score = 0;
  for (const c of concepts) {
    const sorted = [...c.weights].sort((a, b) => b - a);
    score += sorted[0] + sorted.slice(1).reduce((a, b) => a + b * 0.5, 0);
  }
  return score;
}

function readNote(vaultPath, rel) {
  try {
    const fd = fs.openSync(path.join(vaultPath, rel), "r");
    try {
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function termCounts(text) {
  const counts = {};
  for (const t of tokenizeWithPositions(text)) counts[t.token] = (counts[t.token] || 0) + 1;
  return counts;
}

const squash = (text) => String(text ?? "").replace(/\s+/gu, "").toLowerCase();

function pickBestSection(content, queryTokens, preferredHeading = null) {
  const sections = extractNoteSections(content);
  if (sections.length === 0) return { heading: "(top)", startLine: 1, endLine: 1, snippet: "" };
  const tokenSet = new Set(queryTokens.map((t) => t.token));
  let best = null;
  let bestScore = -Infinity;
  sections.forEach((sec) => {
    const headTokens = new Set(tokenizeWithPositions(sec.heading).map((t) => t.token));
    const bodyTokens = new Set(tokenizeWithPositions(sec.text).map((t) => t.token));
    let s = 0;
    for (const tok of tokenSet) {
      if (headTokens.has(tok)) s += 3;
      else if (bodyTokens.has(tok)) s += 1;
    }
    if (preferredHeading && sec.heading === preferredHeading) s += 2.5;
    if (sec.boilerplate) s -= 2;
    if (s > bestScore) {
      bestScore = s;
      best = sec;
    }
  });
  const chosen = best ?? sections[0];
  const rawSnippet = chosen.cleanText || chosen.text.replace(/\s+/gu, " ").trim();
  const snippet = rawSnippet.length > SNIPPET_CHARS ? `${rawSnippet.slice(0, SNIPPET_CHARS - 1)}…` : rawSnippet;
  return { heading: chosen.heading, startLine: chosen.startLine, endLine: chosen.endLine, snippet };
}

async function resolveSemanticScores(index, scopedNotes, query, { vaultPath, embedFn = null, embeddingCachePath = defaultEmbeddingCachePath(), now = Date.now() } = {}) {
  let activeEmbed = embedFn;
  let router = null;
  try {
    if (!activeEmbed) {
      const cfg = memoryJudgeFromEnv(process.env);
      if (cfg.mode === "off" || cfg.vaultSemantic === false) return null;
      router = createMemoryRouter(cfg, { useCache: true });
      const probe = await router.embedTexts([query], "query", { timeout: 2500 });
      if (!probe?.vectors?.[0]) return null;
      const model = probe.model;
      const queryVec = probe.vectors[0];
      const cache = loadEmbeddingCache(embeddingCachePath, { vaultPath, model });
      try {
        await backfillEmbeddings(index, cache, async (texts) => {
          const out = await router.embedTexts(texts, "passage", { timeout: 4000 });
          if (!out || out.model !== model) throw new Error("embedder mismatch");
          return out.vectors;
        }, embeddingCachePath);
      } catch {}
      return scoreCache(scopedNotes, cache, queryVec);
    }

    const qOut = await activeEmbed([query], "query");
    const queryVec = qOut?.vectors?.[0];
    if (!queryVec || !qOut?.model) return null;
    const cache = loadEmbeddingCache(embeddingCachePath, { vaultPath, model: qOut.model });
    await backfillEmbeddings(index, cache, async (texts) => (await activeEmbed(texts, "passage"))?.vectors ?? [], embeddingCachePath);
    return scoreCache(scopedNotes, cache, queryVec);
  } catch {
    return null;
  } finally {
    router?.dispose?.();
  }
}

function scoreCache(scopedNotes, cache, queryVec) {
  const scores = new Map();
  const allScores = [];
  for (const note of scopedNotes) {
    const entry = cache.entries?.[note.path];
    if (!entry || entry.hash !== note.hash) continue;
    const rawVecs = Array.isArray(entry.chunks) && entry.chunks.length ? entry.chunks : (isVector(entry.v) ? [entry.v] : []);
    let best = -Infinity;
    let bestIdx = 0;
    rawVecs.forEach((vec, idx) => {
      if (!isVector(vec) || vec.length !== queryVec.length) return;
      const s = dot(vec, queryVec);
      if (s > best || (s === best && idx > 0 && bestIdx === 0)) { best = s; bestIdx = idx; }
    });
    if (best > -Infinity) {
      scores.set(note.path, { score: best, chunkIdx: bestIdx });
      allScores.push(best);
    }
  }
  if (allScores.length === 0) return null;
  allScores.sort((a, b) => b - a);
  const median = allScores[Math.floor(allScores.length / 2)];
  return { scores, median };
}

/**
 * Search Vault notes within scope and return section-localized matches with 1-based line ranges.
 */
export async function searchVault({
  vaultPath,
  query,
  projectId = null,
  cwd = process.cwd(),
  scope = "project",
  limit = DEFAULT_LIMIT,
  includeDeprecated = false,
  includePending = true,
  semantic = true,
  embedFn = null,
  indexCachePath = defaultIndexCachePath(),
  embeddingCachePath = defaultEmbeddingCachePath(),
  now = Date.now()
} = {}) {
  const cleanQuery = typeof query === "string" ? query.trim() : "";
  if (!vaultPath || !cleanQuery) {
    return { vaultPath: vaultPath ?? null, projectId: null, scope, mode: "none", query: cleanQuery, results: [] };
  }
  const index = loadVaultIndex(vaultPath, { cachePath: indexCachePath, now });
  if (!index) {
    return { vaultPath, projectId: null, scope, mode: "none", query: cleanQuery, results: [] };
  }

  const resolvedProject = scope === "global"
    ? "global"
    : (scope === "all" ? null : (projectId ?? resolveProjectIdFromCwd(vaultPath, cwd)));
  const mentionedProjects = scope === "project" ? mentionedProjectIds(index, cleanQuery, resolvedProject) : [];
  const scopedNotes = index.notes.filter((note) => {
    if (!includeDeprecated && note.deprecated) return false;
    if (!includePending && note.pending) return false;
    if (scope === "global") return note.projectId === "global";
    if (scope === "project") {
      // An unresolved project searches Global and the projects the query names, never every project.
      return note.projectId === "global" || (resolvedProject && note.projectId === resolvedProject) || mentionedProjects.includes(note.projectId);
    }
    return true;
  });
  const projectUnresolved = scope === "project" && !resolvedProject;

  const queryTokens = uniqueQueryTokens(cleanQuery, resolvedProject);
  const n = Math.max(1, index.n || index.notes.length);
  const idf = (token) => Math.log(1 + n / (index.df[token] || n));
  const sem = semantic
    ? await resolveSemanticScores(index, scopedNotes, cleanQuery, { vaultPath, embedFn, embeddingCachePath, now })
    : null;

  // The router's index holds topic words only (title, headings, identifiers); search also reads the bodies
  // of the scoped notes so a phrase that only appears in the text is found.
  const contents = new Map();
  const bodyTerms = new Map();
  const bodyDf = {};
  for (const note of scopedNotes) {
    const raw = readNote(vaultPath, note.path);
    if (raw === null) continue;
    contents.set(note.path, raw);
    const counts = termCounts(parseFrontmatter(raw).body);
    bodyTerms.set(note.path, counts);
    for (const token of Object.keys(counts)) bodyDf[token] = (bodyDf[token] || 0) + 1;
  }
  const bodyN = Math.max(1, bodyTerms.size);
  const bodyIdf = (token) => Math.log(1 + bodyN / (bodyDf[token] || bodyN));
  const phrase = squash(cleanQuery);

  const ranked = [];
  for (const note of scopedNotes) {
    const raw = contents.get(note.path);
    if (raw === undefined) continue;
    let lex = lexicalScore(note.terms, queryTokens, idf) + BODY_WEIGHT * lexicalScore(bodyTerms.get(note.path), queryTokens, bodyIdf);
    if (phrase.length >= 2 && squash(parseFrontmatter(raw).body).includes(phrase)) lex += PHRASE_BONUS;
    if (lex > 0 && mentionedProjects.includes(note.projectId)) lex += 2;
    const semEntry = sem?.scores.get(note.path) ?? null;
    const prom = semEntry ? Math.max(0, semEntry.score - sem.median) : 0;
    if (lex <= 0 && (!semEntry || prom < 0.02)) continue;
    const combined = lex + prom * 35;
    ranked.push({
      note,
      score: Math.round(combined * 100) / 100,
      lexicalScore: Math.round(lex * 100) / 100,
      semanticScore: semEntry ? Math.round(semEntry.score * 10000) / 10000 : null,
      chunkIdx: semEntry?.chunkIdx ?? 0
    });
  }
  ranked.sort((a, b) => b.score - a.score);

  const results = [];
  for (const item of ranked.slice(0, limit)) {
    const rawContent = contents.get(item.note.path);
    if (rawContent === undefined) continue;
    const preferredHeading = item.chunkIdx > 0 && Array.isArray(item.note.embedChunks) && item.note.embedChunks[item.chunkIdx]
      ? (item.note.embedChunks[item.chunkIdx].split("\n")[1]?.trim() || null)
      : null;
    const sec = pickBestSection(rawContent, queryTokens, preferredHeading);
    results.push({
      path: item.note.path,
      projectId: item.note.projectId,
      pending: Boolean(item.note.pending),
      deprecated: Boolean(item.note.deprecated),
      score: item.score,
      section: { heading: sec.heading, startLine: sec.startLine, endLine: sec.endLine },
      snippet: sec.snippet
    });
  }

  const mode = sem ? (ranked.some((r) => r.lexicalScore > 0) ? "hybrid" : "semantic") : "lexical";
  return { vaultPath, projectId: resolvedProject, scope, mode, query: cleanQuery, ...(projectUnresolved ? { projectUnresolved: true } : {}), results };
}

export function formatSearchResults(data) {
  const hint = data?.projectUnresolved
    ? "Note: no project matched the current directory, so only Global notes (and projects named in the query) were searched; pass --project <id> or --scope all.\n"
    : "";
  if (!data?.results?.length) {
    return `No matching notes found for "${data?.query ?? ""}" (scope: ${data?.scope ?? "project"}${data?.projectId ? `, project: ${data.projectId}` : ""}).\n${hint}`;
  }
  const lines = [
    `Found ${data.results.length} note(s) [${data.mode}, scope: ${data.scope}${data.projectId ? `, project: ${data.projectId}` : ""}]:`
  ];
  data.results.forEach((r, idx) => {
    const tags = [r.pending ? "pending" : null, r.deprecated ? "deprecated" : null].filter(Boolean).join(", ");
    lines.push(`${idx + 1}. ${r.path}:${r.section.startLine}-${r.section.endLine}  (score: ${r.score}${tags ? `, ${tags}` : ""})`);
    lines.push(`   Section: ${r.section.heading}`);
    if (r.snippet) lines.push(`   Snippet: ${r.snippet}`);
  });
  return lines.join("\n") + "\n" + hint;
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out.write(`Usage: laya search "<query>" [--project <id>] [--scope project|global|all] [--limit N] [--include-deprecated] [--no-pending] [--no-semantic] [--json] [--vault <path>]\n`);
    return 0;
  }
  if (!opts.query.trim()) {
    err.write("Error: Please provide a search query.\n");
    return 1;
  }
  const vaultPath = opts.vaultPath ?? resolveVaultPath();
  if (!vaultPath) {
    err.write("Error: Could not detect Obsidian Vault. Specify --vault <absolute-path> or set OBSIDIAN_MEMORY_VAULT.\n");
    return 1;
  }
  const data = await searchVault({
    vaultPath,
    query: opts.query,
    projectId: opts.projectId,
    cwd: opts.cwd,
    scope: opts.scope,
    limit: opts.limit,
    includeDeprecated: opts.includeDeprecated,
    includePending: opts.includePending,
    semantic: opts.semantic
  });
  if (opts.json) out.write(JSON.stringify(data, null, 2) + "\n");
  else out.write(formatSearchResults(data));
  return 0;
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) {
  main().then((code) => process.exit(code));
}
