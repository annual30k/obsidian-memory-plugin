/**
 * Vault-aware recall hints.
 *
 * Laya only sees the prompt text, so it cannot know that the Vault already holds a note about
 * "the broken symlink in the installer" or "the WeChat chat ordering". This module builds a small
 * term index from the Vault's curated notes (titles, file names, aliases, tags and `code`
 * identifiers of wiki + inbox notes) and scores a prompt against it with IDF-weighted term overlap.
 *
 * - Read-only: never writes to the Vault. The index is cached under the plugin cache directory.
 * - Cheap: the cache is reused until a scanned directory changes or the TTL expires, so a hook
 *   process pays one JSON read plus a few stat() calls.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { homedir } from "node:os";
import { cacheFile } from "./paths.js";

export const INDEX_VERSION = 8;
export const EMBEDDING_CACHE_VERSION = 1;
// Semantic match strengths on "prominence": the best note's cosine minus the median cosine over the
// candidate notes. Absolute cosine is not usable (a bi-encoder scores every note of the current
// project alike); prominence asks whether one note stands out. Measured on the author's Vault with
// multilingual-e5-small against 501 real prompts: weak = 80th percentile of unrelated prompts,
// strong = 97th (see the gate experiment behind ARCHITECTURE.md "每轮路由").
export const DEFAULT_SEMANTIC_THRESHOLDS = Object.freeze({ weak: 0.038, strong: 0.048 });
export const MIN_SEMANTIC_CANDIDATES = 5;
// Below this many candidates the prominence reference is the whole Vault instead of the scope.
export const SMALL_SCOPE_CANDIDATES = 20;
const EMBED_BODY_CHARS = 600;
const INDEX_TTL_MS = 10 * 60 * 1000;
const MAX_NOTES = 2000;
const MAX_BODY_BYTES = 16384;
const MAX_CODE_TERMS = 40;

// Match strengths. Calibrated on the author's Vault (see scripts/calibrate-vault-hints.mjs):
// "strong" should almost never fire on general programming questions.
export const DEFAULT_VAULT_THRESHOLDS = Object.freeze({ weak: 6.0, strong: 8.0 });

const ASCII_STOP = new Set(`a an and are as at be by can do does for from get how i if in into is it its me my of on or our so than that the their then there these this to use used using via was we what when where which who why will with you your
md js ts mjs py file files code test tests note notes new add fix run make set get one two not no yes all any also just like need want should would could please help write create update change`.split(/\s+/u));

// Function-word bigrams that carry no topic.
const CJK_STOP = new Set(["的是", "是什", "什么", "怎么", "如何", "为什", "什么", "一个", "这个", "那个", "我们", "咱们", "可以", "一下", "帮我", "请帮", "我的", "你的", "是否", "有没", "没有", "时候", "问题", "现在", "之前", "上次", "以前", "当时", "处理", "一样", "这样", "那样", "还是", "就是", "不是", "需要", "应该", "然后", "所以", "因为", "但是", "如果", "进行", "使用", "实现", "方法", "代码", "函数", "文件"]);

const CJK_RUN = /[㐀-鿿豈-﫿]+/gu;
const ASCII_RUN = /[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]/gu;

/**
 * Tokens with a "concept" group id: overlapping CJK bigrams of one contiguous run share a group
 * candidate chain (resolved in matchVault); each ASCII word part is its own concept.
 * Compound identifiers ("managed-block", "node.js") are split into parts so one word never counts twice.
 */
export function tokenizeWithPositions(text) {
  const tokens = [];
  if (typeof text !== "string" || !text) return tokens;
  const lower = text.normalize("NFKC").toLowerCase();
  let run = 0;
  for (const match of lower.matchAll(CJK_RUN)) {
    const chunk = match[0];
    run++;
    if (chunk.length === 1) continue;
    for (let i = 0; i < chunk.length - 1; i++) {
      const bigram = chunk.slice(i, i + 2);
      if (!CJK_STOP.has(bigram)) tokens.push({ token: bigram, run, pos: i, cjk: true });
    }
  }
  for (const match of lower.matchAll(ASCII_RUN)) {
    for (const part of match[0].split(/[._-]+/u)) {
      if (part.length >= 3 && !ASCII_STOP.has(part) && !/^\d+$/u.test(part)) tokens.push({ token: stem(part), cjk: false });
    }
  }
  return tokens;
}

// Light English plural folding so "skills"/"skill" and "hooks"/"hook" meet.
function stem(word) {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  return tokenizeWithPositions(text).map((t) => t.token);
}

// ---------------------------------------------------------------- note parsing

function readHead(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

// Minimal YAML frontmatter reader for the flat templates the skill writes.
export function parseFrontmatter(text) {
  const out = {};
  if (!text.startsWith("---")) return { data: out, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: out, body: text };
  const lines = text.slice(3, end).split(/\r?\n/u);
  let listKey = null;
  for (const line of lines) {
    const item = /^\s+-\s+(.*)$/u.exec(line);
    if (item && listKey) {
      out[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (!kv) { listKey = null; continue; }
    const [, key, raw] = kv;
    if (raw === "") {
      out[key] = [];
      listKey = key;
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      out[key] = raw.slice(1, -1).split(",").map(unquote).filter(Boolean);
      listKey = null;
    } else {
      out[key] = unquote(raw);
      listKey = null;
    }
  }
  const body = text.slice(end + 4);
  return { data: out, body };
}

function asList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return typeof value === "string" && value ? [value] : [];
}

/** Topic text of one note: title, file slug, aliases, tags and inline `code` identifiers. */
export function noteTopicText(filePath, content) {
  const { data, body } = parseFrontmatter(content);
  const parts = [];
  const title = typeof data.title === "string" && data.title ? data.title : (/^#\s+(.+)$/mu.exec(body)?.[1] ?? "");
  parts.push(title, title); // titles count double
  parts.push(path.basename(filePath, ".md").replace(/^\d{4}-\d{2}-\d{2}-/u, "").replace(/[-_]+/gu, " "));
  parts.push(...asList(data.aliases), ...asList(data.tags), ...asList(data.summary));
  // Distinctive identifiers from the body: `code` spans, error codes (EEXIST), camelCase APIs
  // (existsSync, linkPlugin) and file names. Plain body prose is left out on purpose: it would
  // make general questions match too easily.
  const codeTerms = new Set();
  const add = (term) => { if (codeTerms.size < MAX_CODE_TERMS) codeTerms.add(term); };
  for (const match of body.matchAll(/`([^`\n]{3,80})`/gu)) {
    for (const word of match[1].match(/[A-Za-z_][\w.@/-]{2,}/gu) || []) add(word);
  }
  for (const match of body.matchAll(/\b(?:[A-Z][A-Z0-9_]{3,}|[a-z]+[A-Z][A-Za-z0-9]*|[\w-]+\.(?:m?js|ts|py|json|ya?ml|sh|md))\b/gu)) {
    add(match[0]);
  }
  parts.push(...codeTerms);
  return parts.filter(Boolean).join("\n");
}

/** What the retriever embeds for one note: the topic line plus the start of the body. */
export function noteEmbedText(filePath, content) {
  const { body } = parseFrontmatter(content);
  const prose = body.replace(/\s+/gu, " ").trim().slice(0, EMBED_BODY_CHARS);
  return `${noteTopicText(filePath, content)}\n${prose}`.trim();
}

// ---------------------------------------------------------------- scanning

function listMarkdown(dir, { recursive }) {
  const files = [];
  const dirs = [];
  const walk = (current, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    dirs.push(current);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < 4 && entry.name !== "assets") walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !["index.md", "log.md", "README.md"].includes(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(dir, 0);
  return { files, dirs };
}

/** Directories whose notes are indexed, grouped by project id ("global" for 10-Global). */
export function scanTargets(vaultPath) {
  const targets = [
    { projectId: "global", dir: path.join(vaultPath, "10-Global", "wiki"), recursive: true },
    { projectId: "global", dir: path.join(vaultPath, "10-Global", "inbox"), recursive: false }
  ];
  let projects = [];
  try {
    projects = fs.readdirSync(path.join(vaultPath, "20-Projects"), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
  } catch {}
  for (const entry of projects) {
    const base = path.join(vaultPath, "20-Projects", entry.name);
    targets.push({ projectId: entry.name, dir: path.join(base, "wiki"), recursive: true });
    targets.push({ projectId: entry.name, dir: path.join(base, "inbox"), recursive: false });
  }
  return targets;
}

function directorySignature(dirs) {
  const hash = crypto.createHash("sha1");
  for (const dir of [...dirs].sort()) {
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch {}
    hash.update(`${dir}\0${mtime}\n`);
  }
  return hash.digest("hex");
}

/** Project display names ("PocketClaw-d65c3b67" -> "pocketclaw"), used for cross-project mentions. */
export function projectNameKey(projectId) {
  return String(projectId).replace(/-[0-9a-f]{8}$/iu, "").toLowerCase().replace(/[^a-z0-9㐀-鿿]+/gu, "");
}

/**
 * Which files to index when the Vault holds more than `max` notes: every Global note, then an even share
 * per project (a project needing less leaves its share to the others), newest notes first within a project.
 * A plain directory-order cut dropped whole projects silently. Returns { chosen: Set, truncated: {id: n} }.
 */
export function allocateIndexSlots(candidates, max = MAX_NOTES) {
  if (candidates.length <= max) return { chosen: new Set(candidates.map((c) => c.file)), truncated: {} };
  const byProject = new Map();
  for (const c of candidates) {
    if (!byProject.has(c.projectId)) byProject.set(c.projectId, []);
    byProject.get(c.projectId).push(c);
  }
  for (const list of byProject.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = new Set();
  const take = (list, n) => { for (const c of list.slice(0, n)) chosen.add(c.file); };
  const global = byProject.get("global") ?? [];
  take(global, max);
  let left = max - Math.min(global.length, max);
  let projects = [...byProject.keys()].filter((id) => id !== "global").map((id) => ({ id, list: byProject.get(id), taken: 0 }));
  while (left > 0 && projects.length) {
    const share = Math.max(1, Math.floor(left / projects.length));
    for (const p of projects) {
      const n = Math.min(share, p.list.length - p.taken, left);
      take(p.list.slice(p.taken), n);
      p.taken += n;
      left -= n;
      if (left <= 0) break;
    }
    projects = projects.filter((p) => p.taken < p.list.length);
  }
  const truncated = {};
  for (const [id, list] of byProject) {
    const dropped = list.filter((c) => !chosen.has(c.file)).length;
    if (dropped) truncated[id] = dropped;
  }
  return { chosen, truncated };
}

export function buildVaultIndex(vaultPath) {
  const notes = [];
  const scannedDirs = [path.join(vaultPath, "20-Projects")];
  const candidates = [];
  for (const target of scanTargets(vaultPath)) {
    const { files, dirs } = listMarkdown(target.dir, { recursive: target.recursive });
    scannedDirs.push(...dirs);
    for (const file of files) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
      candidates.push({ target, file, projectId: target.projectId, mtimeMs });
    }
  }
  const { chosen, truncated } = allocateIndexSlots(candidates);
  for (const { target, file } of candidates) {
    if (!chosen.has(file)) continue;
    const head = readHead(file, MAX_BODY_BYTES);
    const topic = noteTopicText(file, head);
    const counts = {};
    for (const token of tokenize(topic)) counts[token] = (counts[token] || 0) + 1;
    if (Object.keys(counts).length === 0) continue;
    const embedText = noteEmbedText(file, head);
    notes.push({
      path: path.relative(vaultPath, file).split(path.sep).join("/"),
      projectId: target.projectId,
      pending: target.dir.endsWith(`${path.sep}inbox`),
      terms: counts,
      embedText,
      hash: crypto.createHash("sha1").update(embedText).digest("hex").slice(0, 20)
    });
  }
  const df = {};
  for (const note of notes) for (const token of Object.keys(note.terms)) df[token] = (df[token] || 0) + 1;
  const projectIds = [...new Set(notes.map((n) => n.projectId).filter((id) => id !== "global"))];
  return {
    version: INDEX_VERSION,
    vaultPath,
    builtAt: Date.now(),
    signature: directorySignature(scannedDirs),
    scannedDirs,
    n: notes.length,
    ...(Object.keys(truncated).length ? { truncated } : {}),
    df,
    projects: projectIds.map((id) => ({ id, key: projectNameKey(id) })).filter((p) => p.key.length >= 4),
    notes
  };
}

export function defaultIndexCachePath(options = {}) {
  return cacheFile("vault-index.json", options);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function writeJsonAtomic(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {}
}

/**
 * Cached index for a Vault. Rebuilds when the Vault path, index version or any scanned
 * directory's mtime changes, or after INDEX_TTL_MS (note edits do not touch directory mtimes).
 */
export function loadVaultIndex(vaultPath, { cachePath = defaultIndexCachePath(), now = Date.now(), ttlMs = INDEX_TTL_MS } = {}) {
  if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath)) return null;
  try {
    if (!fs.statSync(path.join(vaultPath, "20-Projects")).isDirectory()) return null;
  } catch {
    return null;
  }
  const cached = readJson(cachePath);
  if (
    cached && cached.version === INDEX_VERSION && cached.vaultPath === vaultPath &&
    now - cached.builtAt < ttlMs && Array.isArray(cached.scannedDirs) &&
    directorySignature(cached.scannedDirs) === cached.signature &&
    // New project folders change the 20-Projects mtime, which is part of scannedDirs.
    true
  ) {
    return cached;
  }
  const index = buildVaultIndex(vaultPath);
  writeJsonAtomic(cachePath, index);
  return index;
}

// ---------------------------------------------------------------- matching

/** Other projects the prompt names by display name ("pocketclaw"), for cross-project mentions. */
export function mentionedProjectIds(index, text, projectId = null) {
  if (!index?.projects || typeof text !== "string") return [];
  const compact = text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, "");
  return index.projects.filter((p) => p.id !== projectId && compact.includes(p.key)).map((p) => p.id);
}

/**
 * Score a prompt against the index.
 * Returns { strength: "none"|"weak"|"strong", topScore, hits: [{ path, projectId, score, terms }], mentionedProjects }.
 * With a projectId, notes of other projects only count when the prompt names that project.
 */
export function matchVault(index, text, { projectId = null, thresholds = DEFAULT_VAULT_THRESHOLDS, maxHits = 3 } = {}) {
  const empty = { strength: "none", topScore: 0, hits: [], mentionedProjects: [] };
  if (!index || !Array.isArray(index.notes) || index.notes.length === 0 || typeof text !== "string") return empty;
  // Words of the current project's own id ("obsidian-memory-plugin") appear in most of its notes
  // and say nothing about which note is relevant.
  const ownWords = new Set(projectId ? tokenize(String(projectId).replace(/-[0-9a-f]{8}$/iu, "")) : []);
  const queryTokens = [];
  const seen = new Set();
  for (const t of tokenizeWithPositions(stripCodeLike(text))) {
    if (seen.has(t.token) || ownWords.has(t.token)) continue;
    seen.add(t.token);
    queryTokens.push(t);
  }
  if (queryTokens.length === 0) return empty;

  const mentionedProjects = mentionedProjectIds(index, text, projectId);
  // A resolved project limits the candidates even when it has no notes yet (see matchVaultSemantic).
  const knownProject = Boolean(projectId);

  const n = Math.max(1, index.n || index.notes.length);
  const idf = (token) => Math.log(1 + n / (index.df[token] || n));
  const scored = [];
  for (const note of index.notes) {
    if (knownProject && note.projectId !== "global" && note.projectId !== projectId && !mentionedProjects.includes(note.projectId)) continue;
    // Group matched tokens into concepts: consecutive CJK bigrams of one run form one phrase
    // ("软链接" = 软链 + 链接), every ASCII word is its own concept.
    const concepts = [];
    let current = null;
    const matched = [];
    for (const t of queryTokens) {
      if (!note.terms[t.token]) { if (t.cjk) current = null; continue; }
      matched.push(t.token);
      const weight = idf(t.token) * (note.terms[t.token] >= 2 ? 1.3 : 1);
      if (t.cjk && current && current.run === t.run && current.last === t.pos - 1) {
        current.weights.push(weight);
        current.last = t.pos;
      } else {
        current = t.cjk ? { run: t.run, last: t.pos, weights: [weight] } : null;
        concepts.push(current ?? { weights: [weight] });
      }
    }
    // One shared word or short phrase is too weak on its own ("软链接", "Node.js"); a phrase of
    // four or more matching characters ("本地安装再测试") is evidence enough by itself.
    const evidence = concepts.reduce((sum, c) => sum + (c.weights.length >= 3 ? 2 : 1), 0);
    if (evidence < 2) continue;
    let score = 0;
    for (const c of concepts) {
      const sorted = [...c.weights].sort((a, b) => b - a);
      score += sorted[0] + sorted.slice(1).reduce((a, b) => a + b * 0.5, 0);
    }
    if (mentionedProjects.includes(note.projectId)) score += 2;
    scored.push({ path: note.path, projectId: note.projectId, pending: Boolean(note.pending), score: Math.round(score * 100) / 100, concepts: concepts.length, terms: matched });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, maxHits);
  const topScore = hits[0]?.score ?? 0;
  // Long prompts (pasted logs, command lists) share words with many notes by chance: raise the bar
  // with the square root of the prompt's token count beyond a normal question's length.
  // Without a known project every project's notes compete, so chance overlaps are likelier.
  const scopeFactor = knownProject ? 1 : UNSCOPED_FACTOR;
  const lengthFactor = scopeFactor * Math.max(1, Math.sqrt(queryTokens.length / LONG_PROMPT_TOKENS));
  let strength = "none";
  if (topScore >= thresholds.strong * lengthFactor) strength = "strong";
  else if (topScore >= thresholds.weak * lengthFactor) strength = "weak";
  if (strength === "none" && mentionedProjects.length > 0 && hits.length > 0) strength = "weak";
  return { strength, topScore, hits: strength === "none" ? [] : hits, mentionedProjects };
}

// CJK text yields one token per character pair, so a normal two-sentence question is ~40 tokens.
const LONG_PROMPT_TOKENS = 60;
const UNSCOPED_FACTOR = 1.3;

/**
 * Drop code-like chunks before matching: paths, URLs, CLI flags, file names, shell operators and
 * fenced/inline code. They name files and commands, not the topic of a past decision.
 */
export function stripCodeLike(text) {
  return String(text)
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`/gu, (m) => (/^`[\w.-]+`$/u.test(m) ? m.slice(1, -1) : " "))
    .split(/\s+/u)
    .filter((chunk) => !(
      /[\/\\~|<>=$]/u.test(chunk) ||
      /^-{1,2}\w/u.test(chunk) ||
      /^https?:/iu.test(chunk)
    ))
    .join(" ");
}

// ---------------------------------------------------------------- semantic matching (retriever)

export function defaultEmbeddingCachePath(options = {}) {
  return cacheFile("vault-embeddings.json", options);
}

/** Cached note vectors for one Vault and retriever model; a fresh empty cache when anything differs. */
export function loadEmbeddingCache(cachePath, { vaultPath, model }) {
  const cached = readJson(cachePath);
  if (
    cached && cached.version === EMBEDDING_CACHE_VERSION && cached.vaultPath === vaultPath &&
    cached.model === model && cached.entries && typeof cached.entries === "object"
  ) {
    return cached;
  }
  return { version: EMBEDDING_CACHE_VERSION, vaultPath, model, dim: null, entries: {} };
}

/** Notes of the index whose vector is missing or stale (content changed). */
export function pendingEmbeddings(index, cache) {
  if (!index?.notes || !cache?.entries) return [];
  return index.notes.filter((note) => note.embedText && cache.entries[note.path]?.hash !== note.hash);
}

/**
 * Embed up to `maxNotes` pending notes through `embedFn(texts) -> vectors` and persist the cache.
 * Bounded per call so a hook never spends more than one batch on indexing; the rest follows on the
 * next turns. Entries of notes that left the index are dropped. Returns { embedded, pending }.
 */
export async function ensureVaultEmbeddings(index, cache, embedFn, { cachePath, maxNotes = 32 } = {}) {
  const pending = pendingEmbeddings(index, cache);
  const batch = pending.slice(0, Math.max(0, maxNotes));
  let embedded = 0;
  if (batch.length > 0) {
    const vectors = await embedFn(batch.map((note) => note.embedText));
    if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new TypeError("embedFn returned the wrong number of vectors");
    for (let i = 0; i < batch.length; i++) {
      const vector = vectors[i];
      if (!Array.isArray(vector) || vector.length === 0) continue;
      if (cache.dim && vector.length !== cache.dim) throw new TypeError("embedding size changed");
      cache.dim = vector.length;
      cache.entries[batch[i].path] = { hash: batch[i].hash, v: vector };
      embedded++;
    }
  }
  const live = new Set(index.notes.map((note) => note.path));
  let pruned = 0;
  for (const key of Object.keys(cache.entries)) if (!live.has(key)) { delete cache.entries[key]; pruned++; }
  if (embedded > 0 || pruned > 0) {
    cache.builtAt = Date.now();
    if (cachePath) writeJsonAtomic(cachePath, cache);
  }
  return { embedded, pending: pending.length - embedded };
}

function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Score a prompt vector against the cached note vectors.
 * Returns { strength: "none"|"weak"|"strong", top, prominence, candidates, hits: [{ path, projectId, pending, score }] }.
 * Candidate notes follow matchVault's scoping: with a known projectId, that project's and global
 * notes, plus projects the prompt names. Prominence is undefined below MIN_SEMANTIC_CANDIDATES.
 */
export function matchVaultSemantic(index, cache, queryVector, { projectId = null, mentionedProjects = [], thresholds = DEFAULT_SEMANTIC_THRESHOLDS, maxHits = 3 } = {}) {
  const empty = { strength: "none", top: 0, prominence: 0, candidates: 0, hits: [] };
  if (!index?.notes?.length || !cache?.entries || !Array.isArray(queryVector) || queryVector.length === 0) return empty;
  // A resolved project always limits the candidates to itself, Global and projects the prompt names,
  // even when it has no notes yet: other private projects never leak into its hints.
  const scoped = Boolean(projectId);
  const scored = [];
  const background = [];
  for (const note of index.notes) {
    const entry = cache.entries[note.path];
    if (!entry || entry.hash !== note.hash || !Array.isArray(entry.v) || entry.v.length !== queryVector.length) continue;
    const score = dot(entry.v, queryVector);
    background.push(score);
    if (scoped && note.projectId !== "global" && note.projectId !== projectId && !mentionedProjects.includes(note.projectId)) continue;
    scored.push({ path: note.path, projectId: note.projectId, pending: Boolean(note.pending), score });
  }
  if (scored.length === 0 || background.length < MIN_SEMANTIC_CANDIDATES) return { ...empty, candidates: scored.length };
  scored.sort((a, b) => b.score - a.score);
  // Prominence compares the best candidate with a typical note. In a small scope (a project with a few
  // notes plus Global) the scope's own median is noise and almost every prompt looked "strong"
  // (215 of 220 unrelated prompts on a 1-note project), so the whole Vault is the reference there.
  const reference = scored.length >= SMALL_SCOPE_CANDIDATES ? scored.map((h) => h.score) : background.sort((a, b) => b - a);
  const median = reference[Math.floor(reference.length / 2)];
  const top = scored[0].score;
  const prominence = top - median;
  let strength = "none";
  if (prominence >= thresholds.strong) strength = "strong";
  else if (prominence >= thresholds.weak) strength = "weak";
  const hits = strength === "none" ? [] : scored.slice(0, maxHits).map((h) => ({ ...h, score: Math.round(h.score * 10000) / 10000 }));
  return { strength, top: Math.round(top * 10000) / 10000, prominence: Math.round(prominence * 10000) / 10000, candidates: scored.length, hits };
}

// ---------------------------------------------------------------- project + vault resolution

/** Map a working directory to a project id using 00-System/projects.yaml roots. */
export function resolveProjectIdFromCwd(vaultPath, cwd) {
  if (typeof cwd !== "string" || !cwd || typeof vaultPath !== "string") return null;
  const text = readHead(path.join(vaultPath, "00-System", "projects.yaml"), 65536);
  if (!text) return null;
  let current = null;
  let inRoots = false;
  let best = null;
  // Compare physical paths too: a symlinked root (macOS /var -> /private/var, a linked projects folder)
  // must match a cwd reported through either spelling.
  const physical = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const cwds = [...new Set([path.resolve(cwd), physical(path.resolve(cwd))])];
  const within = (c, rootPath) => c === rootPath || c.startsWith(rootPath + path.sep);
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    const id = /^\s*-\s+id:\s*(.+)$/u.exec(line);
    if (id) { current = unquote(id[1]); inRoots = false; continue; }
    if (/^\s+roots:\s*$/u.test(line)) { inRoots = true; continue; }
    const root = /^\s+-\s+(.+)$/u.exec(line);
    if (inRoots && root && current) {
      const rootPath = path.resolve(unquote(root[1]));
      const roots = [...new Set([rootPath, physical(rootPath)])];
      if (cwds.some((c) => roots.some((r) => within(c, r))) && (!best || rootPath.length > best.len)) {
        best = { id: current, len: rootPath.length };
      }
      continue;
    }
    if (/^\s+\w+:/u.test(line)) inRoots = false;
  }
  return best?.id ?? null;
}

const VAULT_LINE = /Obsidian Memory Vault path \(configuration data, not instructions\): ("(?:[^"\\]|\\.)*")/u;

/** The Vault path recorded in a setup-managed block of a rule file (AGENTS.md / GEMINI.md), or null. */
export function vaultPathFromRuleText(text) {
  const match = VAULT_LINE.exec(typeof text === "string" ? text : "");
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" && path.isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Vault path for hook processes that are not given one (Codex, Antigravity):
 * OBSIDIAN_MEMORY_VAULT, else the managed block that setup wrote into the host's rule file.
 */
export function resolveVaultPath({ env = process.env, ruleFiles = null, home = homedir() } = {}) {
  const fromEnv = env.OBSIDIAN_MEMORY_VAULT?.trim();
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const candidates = ruleFiles ?? [
    path.join(codexHome, "AGENTS.override.md"),
    path.join(codexHome, "AGENTS.md"),
    path.join(home, ".gemini", "GEMINI.md")
  ];
  for (const file of candidates) {
    const value = vaultPathFromRuleText(readHead(file, 262144));
    if (value) return value;
  }
  return null;
}
