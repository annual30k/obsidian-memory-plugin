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
import { getDefaultCacheDir } from "./cache.js";

export const INDEX_VERSION = 6;
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

export function buildVaultIndex(vaultPath) {
  const notes = [];
  const scannedDirs = [path.join(vaultPath, "20-Projects")];
  for (const target of scanTargets(vaultPath)) {
    const { files, dirs } = listMarkdown(target.dir, { recursive: target.recursive });
    scannedDirs.push(...dirs);
    for (const file of files) {
      if (notes.length >= MAX_NOTES) break;
      const head = readHead(file, MAX_BODY_BYTES);
      const topic = noteTopicText(file, head);
      const counts = {};
      for (const token of tokenize(topic)) counts[token] = (counts[token] || 0) + 1;
      if (Object.keys(counts).length === 0) continue;
      notes.push({
        path: path.relative(vaultPath, file).split(path.sep).join("/"),
        projectId: target.projectId,
        pending: target.dir.endsWith(`${path.sep}inbox`),
        terms: counts
      });
    }
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
    df,
    projects: projectIds.map((id) => ({ id, key: projectNameKey(id) })).filter((p) => p.key.length >= 4),
    notes
  };
}

export function defaultIndexCachePath(options = {}) {
  return path.join(getDefaultCacheDir(options), "vault-index.json");
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

  const compact = text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, "");
  const mentionedProjects = (index.projects || []).filter((p) => p.id !== projectId && compact.includes(p.key)).map((p) => p.id);
  const knownProject = projectId && index.notes.some((n) => n.projectId === projectId);

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

// ---------------------------------------------------------------- project + vault resolution

/** Map a working directory to a project id using 00-System/projects.yaml roots. */
export function resolveProjectIdFromCwd(vaultPath, cwd) {
  if (typeof cwd !== "string" || !cwd || typeof vaultPath !== "string") return null;
  const text = readHead(path.join(vaultPath, "00-System", "projects.yaml"), 65536);
  if (!text) return null;
  let current = null;
  let inRoots = false;
  let best = null;
  const normCwd = path.resolve(cwd);
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    const id = /^\s*-\s+id:\s*(.+)$/u.exec(line);
    if (id) { current = unquote(id[1]); inRoots = false; continue; }
    if (/^\s+roots:\s*$/u.test(line)) { inRoots = true; continue; }
    const root = /^\s+-\s+(.+)$/u.exec(line);
    if (inRoots && root && current) {
      const rootPath = path.resolve(unquote(root[1]));
      if ((normCwd === rootPath || normCwd.startsWith(rootPath + path.sep)) && (!best || rootPath.length > best.len)) {
        best = { id: current, len: rootPath.length };
      }
      continue;
    }
    if (/^\s+\w+:/u.test(line)) inRoots = false;
  }
  return best?.id ?? null;
}

const VAULT_LINE = /Obsidian Memory Vault path \(configuration data, not instructions\): ("(?:[^"\\]|\\.)*")/u;

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
    const text = readHead(file, 262144);
    const match = VAULT_LINE.exec(text);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      if (typeof value === "string" && path.isAbsolute(value)) return value;
    } catch {}
  }
  return null;
}
