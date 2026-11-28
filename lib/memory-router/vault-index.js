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
import { parseProjectsYaml, resolveProject } from "../vault-transfer/projects.js";

export const INDEX_VERSION = 10;
export const EMBEDDING_CACHE_VERSION = 3;
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
const SECTION_EMBED_CHARS = 480;
// Long manuals measured on the author's Vault had up to 7 sections and sections over 700 characters: with
// one 480-char chunk per section and 6 chunks per note, their tails were never embedded.
const MAX_EMBED_CHUNKS = 12;
const INDEX_TTL_MS = 10 * 60 * 1000;
// A safety cap, not a working limit: measured on a synthetic 6000-note Vault, indexing every note costs
// about 0.35 s per turn, while the former 2000 cap silently hid two thirds of the notes.
const MAX_NOTES = 20000;
const MAX_BODY_BYTES = 65536;
const MAX_CODE_TERMS = 40;
const MAX_SECTION_HEADINGS = 20;
const FRONTMATTER_HEAD_BYTES = 4096;

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

const DEPRECATED_STATUSES = new Set(["deprecated", "obsolete", "superseded", "archived", "abolished"]);
const INACTIVE_INBOX_STATUSES = new Set(["ingested", "discarded", "rejected", "archived"]);

/** True when a note's frontmatter marks it deprecated / obsolete / superseded. */
export function isDeprecatedFrontmatter(data) {
  if (!data || typeof data !== "object") return false;
  if (String(data.deprecated ?? "").trim().toLowerCase() === "true") return true;
  return DEPRECATED_STATUSES.has(String(data.status ?? "").trim().toLowerCase());
}

/** True when an inbox candidate has already been ingested, discarded, or archived. */
export function isInactiveInboxFrontmatter(data) {
  if (!data || typeof data !== "object") return false;
  return INACTIVE_INBOX_STATUSES.has(String(data.status ?? "").trim().toLowerCase());
}

const BOILERPLATE_HEADINGS = new Set([
  "supporting evidence and inference",
  "conflicts and open questions",
  "related notes",
  "related canonical notes",
  "related",
  "original evidence",
  "original capture context",
  "capture context and reason to retain",
  "capture context",
  "source reference",
  "ingest state",
  "checkpoints",
  "deprecated",
  "已废除",
  "相关笔记",
  "参考来源",
  "附图索引",
  "附图索引表",
  "附图分类索引",
  "图片索引",
  "evidence",
  "证据",
  "来源"
]);

function normalizeHeadingKey(heading) {
  // "六、附图分类索引" and "3. Related notes" are the same fixed sections as their bare names.
  return String(heading ?? "").trim().toLowerCase()
    .replace(/^(?:[一二三四五六七八九十百]+|\d+(?:\.\d+)*)\s*[、.．)）:：]?\s*/u, "")
    .replace(/\s+/gu, " ");
}

function isBoilerplateHeading(heading) {
  return BOILERPLATE_HEADINGS.has(normalizeHeadingKey(heading));
}

/**
 * Split Markdown `body` into `{ intro, sections: [{ level, heading, text }], proseWithoutCode, codeBlocks }`
 * while tracking fenced code blocks (` ``` ` / `~~~`) line-by-line so `#` comments inside code are never
 * mistaken for Markdown headings.
 */
function parseMarkdownStructure(body) {
  const lines = String(body ?? "").split(/\r?\n/u);
  let fence = null;
  let codeLines = [];
  const codeBlocks = [];
  const proseLines = [];
  const introLines = [];
  const sections = [];
  let currentSection = null;

  const pushLine = (line) => {
    if (currentSection) currentSection.lines.push(line);
    else introLines.push(line);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/u.exec(trimmed);
    if (!fence && fenceMatch) {
      fence = fenceMatch[1][0].repeat(fenceMatch[1].length);
      codeLines = [];
      pushLine(line);
      continue;
    }
    if (fence) {
      pushLine(line);
      if (trimmed.startsWith(fence) && trimmed.slice(fence.length).trim() === "") {
        codeBlocks.push(codeLines.join("\n"));
        fence = null;
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    proseLines.push(line);
    const headingMatch = /^(#{2,3})\s+(.+?)\s*$/u.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = headingMatch[2].replace(/\s+#+\s*$/u, "").trim();
      if (level === 2) {
        currentSection = { level, heading, lines: [] };
        sections.push(currentSection);
      } else {
        // Keep ### subheadings inside the enclosing ## section (or intro) and record for topic terms.
        if (currentSection) currentSection.subheadings = [...(currentSection.subheadings ?? []), heading];
        else sections.push({ level, heading, lines: [], inlineSubheading: true });
        pushLine(line);
      }
      continue;
    }
    pushLine(line);
  }
  if (fence && codeLines.length) codeBlocks.push(codeLines.join("\n"));

  return {
    intro: introLines.join("\n"),
    sections,
    proseWithoutCode: proseLines.join("\n"),
    codeBlocks
  };
}

/** Extract concise, meaningful comments from a fenced code block (skipping dividers & boilerplate). */
const SMALL_CODE_CHARS = 400;
const SMALL_CODE_LINES = 15;
const CODE_OPENING_CHARS = 160;

function extractCodeComments(codeBody) {
  const comments = [];
  const seen = new Set();
  const add = (raw) => {
    const clean = String(raw ?? "").replace(/^[\s/*#\-=!]+|[\s/*#\-=!]+$/gu, "").replace(/\s+/gu, " ").trim();
    if (clean.length < 4 || /^[-=*_]{3,}$/u.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    comments.push(clean);
  };
  for (const line of String(codeBody ?? "").split(/\r?\n/u)) {
    const t = line.trim();
    // Whole-line comments ("# ..." but not "#include" / "#!"), then trailing ones: "x = 1  // ..." and
    // "...  # 业务读取与统计" (a "#" after whitespace and before a space, so "a#b" or "#{x}" are left alone).
    const single = /^(?:\/\/|--|#(?![!\w]))\s*(.+)$/u.exec(t) ?? /\s(?:\/\/|--|#)\s+(.+)$/u.exec(t);
    if (single) add(single[1]);
  }
  for (const m of String(codeBody ?? "").matchAll(/\/\*([\s\S]*?)\*\//gu)) {
    for (const part of m[1].split(/\r?\n/u)) add(part);
  }
  const joined = comments.join("; ");
  return joined.length > 180 ? joined.slice(0, 180) : joined;
}

/**
 * Clean Markdown for semantic embedding: fold large fenced code blocks to their comment summaries,
 * strip Obsidian image embeds and markdown link URLs/table dividers, so the 256-token window stays on
 * natural-language meaning instead of code boilerplate or image syntax.
 */
function cleanMarkdownForEmbed(text) {
  let out = String(text ?? "");
  out = out.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/gu, (_m, lead, _fence, code) => {
    const lines = code.split(/\r?\n/u);
    // A short block is often the point of the note (the fix pattern): embed it as it is.
    if (code.length <= SMALL_CODE_CHARS && lines.length <= SMALL_CODE_LINES) return `${lead}${code}`;
    // A large one is reduced to its comments; one without comments keeps its opening lines, so it does not
    // vanish from the vector altogether.
    const summary = extractCodeComments(code);
    if (summary) return `${lead}[code comments: ${summary}]`;
    const opening = code.replace(/\s+/gu, " ").trim().slice(0, CODE_OPENING_CHARS);
    return opening ? `${lead}[code: ${opening}]` : lead;
  });
  out = out.replace(/!\[\[[^\]\n]+\]\]/gu, " ");
  out = out.replace(/!\[([^\]\n]*)\]\([^)\n]+\)/gu, (_m, alt) => {
    const clean = alt.trim();
    return clean && !/\.(?:png|jpe?g|gif|webp|svg|bmp|pdf)$/iu.test(clean) ? clean : " ";
  });
  out = out.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gmu, " ");
  return out.replace(/\s+/gu, " ").trim();
}

function collectCodeTermsFromText(text, codeTerms) {
  const add = (term) => { if (codeTerms.size < MAX_CODE_TERMS) codeTerms.add(term); };
  for (const match of text.matchAll(/`([^`\n]{3,80})`/gu)) {
    for (const word of match[1].match(/[A-Za-z_][\w.@/-]{2,}/gu) || []) add(word);
  }
  for (const match of text.matchAll(/\b(?:[A-Z][A-Z0-9_]{3,}|[a-z]+[A-Z][A-Za-z0-9]*|[\w-]+\.(?:m?js|ts|py|json|ya?ml|sh|md))\b/gu)) {
    add(match[0]);
  }
}

/** Topic text of one note: title, file slug, aliases, tags, business headings and `code` identifiers. */
export function noteTopicText(filePath, content, { includeCodeBlocks = true } = {}) {
  const { data, body } = parseFrontmatter(content);
  const parts = [];
  const title = typeof data.title === "string" && data.title ? data.title : (/^#\s+(.+)$/mu.exec(body)?.[1] ?? "");
  parts.push(title, title); // titles count double
  parts.push(path.basename(filePath, ".md").replace(/^\d{4}-\d{2}-\d{2}-/u, "").replace(/[-_]+/gu, " "));
  parts.push(...asList(data.aliases), ...asList(data.tags), ...asList(data.summary));

  const structure = parseMarkdownStructure(body);
  const headings = [];
  for (const sec of structure.sections) {
    if (!isBoilerplateHeading(sec.heading)) headings.push(sec.heading);
    for (const sub of sec.subheadings ?? []) {
      if (!isBoilerplateHeading(sub)) headings.push(sub);
    }
    if (headings.length >= MAX_SECTION_HEADINGS) break;
  }
  parts.push(...headings.slice(0, MAX_SECTION_HEADINGS));

  // Distinctive identifiers from prose first so large pasted code blocks do not crowd out prose symbols
  // within MAX_CODE_TERMS; any remaining slots may still capture distinctive identifiers from code blocks.
  const codeTerms = new Set();
  collectCodeTermsFromText(structure.proseWithoutCode, codeTerms);
  if (includeCodeBlocks && codeTerms.size < MAX_CODE_TERMS && structure.codeBlocks.length > 0) {
    collectCodeTermsFromText(structure.codeBlocks.join("\n"), codeTerms);
  }
  parts.push(...codeTerms);
  return parts.filter(Boolean).join("\n");
}

/**
 * One or more embedding texts for a note. Short notes yield 1 chunk; long multi-section notes yield
 * section chunks (long sections in several pieces, capped at MAX_EMBED_CHUNKS) so text after 600 chars stays searchable within the
 * retriever's 256-token window.
 */
export function noteEmbedChunks(filePath, content) {
  const { data, body } = parseFrontmatter(content);
  const topic = noteTopicText(filePath, content, { includeCodeBlocks: false });
  const title = typeof data.title === "string" && data.title ? data.title : (/^#\s+(.+)$/mu.exec(body)?.[1] ?? path.basename(filePath, ".md"));
  const structure = parseMarkdownStructure(body);
  const fullClean = cleanMarkdownForEmbed(body);
  const realSections = structure.sections.filter((s) => !s.inlineSubheading && !isBoilerplateHeading(s.heading));
  const meaningfulSections = realSections
    .map((s) => ({ heading: s.heading, clean: cleanMarkdownForEmbed(s.lines.join("\n")) }))
    .filter((s) => s.clean.length >= 15);

  if (fullClean.length <= EMBED_BODY_CHARS || meaningfulSections.length < 2) {
    const first = `${topic}\n${fullClean.slice(0, EMBED_BODY_CHARS)}`.trim();
    return first ? [first] : [];
  }

  const introClean = cleanMarkdownForEmbed(structure.intro);
  const hasIntro = introClean.length >= 15;
  const lead = hasIntro ? introClean : meaningfulSections[0].clean;
  const chunks = [`${topic}\n${lead.slice(0, EMBED_BODY_CHARS)}`.trim()];
  // Each section becomes one or more pieces of up to SECTION_EMBED_CHARS, cut at sentence ends. Pieces are
  // taken breadth-first (every section's first piece, then every second piece, ...) so the cap drops the
  // tails of long sections before it drops whole sections.
  const pieces = meaningfulSections.map((sec, i) => {
    const text = !hasIntro && i === 0 ? sec.clean.slice(EMBED_BODY_CHARS) : sec.clean;
    return splitSentences(text, SECTION_EMBED_CHARS).filter((piece) => piece.length >= 15)
      .map((piece) => `${title}\n${sec.heading}\n${piece}`.trim());
  });
  for (let round = 0; chunks.length < MAX_EMBED_CHUNKS && pieces.some((list) => list.length > round); round++) {
    for (const list of pieces) {
      if (chunks.length >= MAX_EMBED_CHUNKS) break;
      if (list[round]) chunks.push(list[round]);
    }
  }
  return chunks;
}

/** Split text into pieces of at most `max` characters, at sentence ends where possible. */
function splitSentences(text, max) {
  const sentences = String(text ?? "").match(/[^。！？!?；;\n]+[。！？!?；;]*|[。！？!?；;]+/gu) ?? [];
  const out = [];
  let current = "";
  for (const raw of sentences) {
    let sentence = raw.trim();
    if (!sentence) continue;
    while (sentence.length > max) {
      if (current) { out.push(current); current = ""; }
      out.push(sentence.slice(0, max));
      sentence = sentence.slice(max);
    }
    if (current && current.length + 1 + sentence.length > max) { out.push(current); current = ""; }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) out.push(current);
  return out;
}

/** What the retriever embeds for one note's primary summary: the topic line plus the start of the body. */
export function noteEmbedText(filePath, content) {
  return noteEmbedChunks(filePath, content)[0] ?? "";
}

/**
 * Extract Markdown sections with 1-based file line ranges (`startLine`, `endLine`) for section-aware
 * search and targeted reads. Tracks fenced code blocks so `#` comments inside code are never split.
 */
export function extractNoteSections(content) {
  const rawLines = String(content ?? "").replace(/\r\n?/gu, "\n").split("\n");
  let bodyStart = 0;
  let title = "";
  if (rawLines[0]?.trim() === "---") {
    for (let i = 1; i < rawLines.length; i++) {
      if (rawLines[i].trim() === "---") {
        bodyStart = i + 1;
        break;
      }
      const tm = /^title:\s*(.+)$/u.exec(rawLines[i]);
      if (tm) title = unquote(tm[1]);
    }
  }

  const sections = [];
  let current = null;
  let fence = null;
  const introLines = [];
  let introStartLine = null;

  const pushIntro = (line, lineNum) => {
    if (introStartLine === null && line.trim()) introStartLine = lineNum;
    if (introStartLine !== null) introLines.push(line);
  };

  for (let i = bodyStart; i < rawLines.length; i++) {
    const line = rawLines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/u.exec(trimmed);
    if (!fence && fenceMatch) {
      fence = fenceMatch[1][0].repeat(fenceMatch[1].length);
      if (current) current.lines.push(line);
      else pushIntro(line, lineNum);
      continue;
    }
    if (fence) {
      if (current) current.lines.push(line);
      else pushIntro(line, lineNum);
      if (trimmed.startsWith(fence) && trimmed.slice(fence.length).trim() === "") fence = null;
      continue;
    }

    if (!title) {
      const h1 = /^#\s+(.+?)\s*$/u.exec(line);
      if (h1) title = h1[1].trim();
    }
    const h2 = /^##\s+(.+?)\s*$/u.exec(line);
    if (h2) {
      if (current) {
        current.endLine = lineNum - 1;
      } else if (introLines.length > 0 && introStartLine !== null) {
        const text = introLines.join("\n").trim();
        sections.push({
          heading: title || "(intro)",
          level: 1,
          startLine: introStartLine,
          endLine: lineNum - 1,
          text,
          cleanText: cleanMarkdownForEmbed(text),
          boilerplate: false
        });
      }
      current = {
        heading: h2[1].replace(/\s+#+\s*$/u, "").trim(),
        level: 2,
        startLine: lineNum,
        endLine: rawLines.length,
        lines: [line]
      };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else pushIntro(line, lineNum);
  }

  if (!current && introLines.length > 0 && introStartLine !== null) {
    const text = introLines.join("\n").trim();
    sections.push({
      heading: title || "(intro)",
      level: 1,
      startLine: introStartLine,
      endLine: rawLines.length,
      text,
      cleanText: cleanMarkdownForEmbed(text),
      boilerplate: false
    });
  }

  return sections.map((s) => {
    if (s.text !== undefined) {
      let end = s.endLine;
      while (end > s.startLine && rawLines[end - 1].trim() === "") end--;
      return { ...s, endLine: end };
    }
    let end = s.endLine;
    while (end > s.startLine && rawLines[end - 1].trim() === "") end--;
    const text = s.lines.join("\n").trim();
    return {
      heading: s.heading,
      level: s.level,
      startLine: s.startLine,
      endLine: end,
      text,
      cleanText: cleanMarkdownForEmbed(text),
      boilerplate: isBoilerplateHeading(s.heading)
    };
  });
}

// ---------------------------------------------------------------- scanning

// Navigation pages are not notes. Sub-indexes (wiki/index-<module>.md) only count at the top of a scanned
// directory: "wiki/knowledge/index-rebuild.md" is an ordinary note about an index.
function isIndexOrNavFile(name, depth) {
  return ["index.md", "log.md", "README.md", "raw-index.md"].includes(name) || (depth === 0 && /^index-.+\.md$/iu.test(name));
}

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
        // inbox/ is scanned flat, so inbox/archive/ is never walked; a wiki/archive/ folder is the user's own.
        if (recursive && depth < 4 && entry.name !== "assets") walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !isIndexOrNavFile(entry.name, depth)) {
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

function fileSignature(files) {
  return signatureOf(files.map((file) => {
    let st = null;
    try { st = fs.statSync(file); } catch {}
    return [file, st ? st.mtimeMs : 0, st ? st.size : 0];
  }));
}

function signatureOf(stats) {
  const hash = crypto.createHash("sha1");
  for (const [file, mtimeMs, size] of [...stats].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    hash.update(`${file}\0${mtimeMs}\0${size}\n`);
  }
  return hash.digest("hex");
}

/** Project display names ("PocketClaw-d65c3b67" -> "pocketclaw"), used for cross-project mentions. */
export function projectNameKey(projectId) {
  return String(projectId).replace(/-[0-9a-f]{8}$/iu, "").toLowerCase().replace(/[^a-z0-9㐀-鿿]+/gu, "");
}

/**
 * Which files to index when the Vault holds more than `max` notes: every Global note, then an even share
 * per project (a project needing less leaves its share to the others), active notes before deprecated ones,
 * newest notes first within each group. Returns { chosen: Set, truncated: {id: n} }.
 */
export function allocateIndexSlots(candidates, max = MAX_NOTES) {
  if (candidates.length <= max) return { chosen: new Set(candidates.map((c) => c.file)), truncated: {} };
  const byProject = new Map();
  for (const c of candidates) {
    if (!byProject.has(c.projectId)) byProject.set(c.projectId, []);
    byProject.get(c.projectId).push(c);
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => (Number(Boolean(a.deprecated)) - Number(Boolean(b.deprecated))) || (b.mtimeMs - a.mtimeMs));
  }
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

/**
 * Build the index. With `previous` (an index of the same version and Vault), a file whose mtime and size
 * are unchanged is not read again: its frontmatter flags and note come from `previous`, so editing one
 * note in a large Vault re-reads one file instead of all of them.
 */
export function buildVaultIndex(vaultPath, { previous = null } = {}) {
  const notes = [];
  const scannedDirs = [path.join(vaultPath, "20-Projects")];
  const scannedFiles = [];
  const stats = [];
  const fileMeta = {};
  const reusable = previous && previous.version === INDEX_VERSION && previous.vaultPath === vaultPath && previous.fileMeta;
  const prevMeta = reusable ? previous.fileMeta : {};
  const prevNotes = new Map(reusable && Array.isArray(previous.notes) ? previous.notes.map((n) => [n.path, n]) : []);
  const unchanged = new Set();
  const candidates = [];
  for (const target of scanTargets(vaultPath)) {
    const { files, dirs } = listMarkdown(target.dir, { recursive: target.recursive });
    scannedDirs.push(...dirs);
    const isInbox = target.dir.endsWith(`${path.sep}inbox`);
    for (const file of files) {
      scannedFiles.push(file);
      let mtimeMs = 0;
      let size = 0;
      try { const st = fs.statSync(file); mtimeMs = st.mtimeMs; size = st.size; } catch {}
      stats.push([file, mtimeMs, size]);
      const meta = prevMeta[file];
      let inactive;
      let deprecated;
      if (Array.isArray(meta) && meta[0] === mtimeMs && meta[1] === size) {
        unchanged.add(file);
        inactive = meta[2] === 1;
        deprecated = meta[3] === 1;
      } else {
        const { data } = parseFrontmatter(readHead(file, FRONTMATTER_HEAD_BYTES));
        inactive = isInbox && isInactiveInboxFrontmatter(data);
        deprecated = isDeprecatedFrontmatter(data);
      }
      fileMeta[file] = [mtimeMs, size, inactive ? 1 : 0, deprecated ? 1 : 0];
      if (inactive) continue;
      candidates.push({ target, file, projectId: target.projectId, mtimeMs, deprecated });
    }
  }
  const { chosen, truncated } = allocateIndexSlots(candidates);
  for (const { target, file, deprecated } of candidates) {
    if (!chosen.has(file)) continue;
    const rel = path.relative(vaultPath, file).split(path.sep).join("/");
    const old = unchanged.has(file) ? prevNotes.get(rel) : null;
    if (old) {
      const { deprecated: _wasDeprecated, ...rest } = old;
      notes.push({ ...rest, projectId: target.projectId, pending: target.dir.endsWith(`${path.sep}inbox`), ...(deprecated ? { deprecated: true } : {}) });
      continue;
    }
    const head = readHead(file, MAX_BODY_BYTES);
    const topic = noteTopicText(file, head);
    const counts = {};
    for (const token of tokenize(topic)) counts[token] = (counts[token] || 0) + 1;
    if (Object.keys(counts).length === 0) continue;
    const embedChunks = noteEmbedChunks(file, head);
    const embedText = embedChunks[0] ?? "";
    notes.push({
      path: rel,
      projectId: target.projectId,
      pending: target.dir.endsWith(`${path.sep}inbox`),
      ...(deprecated ? { deprecated: true } : {}),
      terms: counts,
      embedText,
      ...(embedChunks.length > 1 ? { embedChunks } : {}),
      hash: crypto.createHash("sha1").update(embedChunks.join("\0")).digest("hex").slice(0, 20)
    });
  }
  const df = {};
  for (const note of notes) for (const token of Object.keys(note.terms)) df[token] = (df[token] || 0) + 1;
  const projectIds = [...new Set(notes.map((n) => n.projectId).filter((id) => id !== "global"))];
  return {
    version: INDEX_VERSION,
    vaultPath,
    builtAt: Date.now(),
    // When every file was last read in full; incremental rebuilds keep it (see loadVaultIndex).
    fullBuiltAt: reusable ? (previous.fullBuiltAt ?? previous.builtAt) : Date.now(),
    signature: directorySignature(scannedDirs),
    fileSignature: signatureOf(stats),
    scannedDirs,
    scannedFiles,
    fileMeta,
    n: notes.length,
    ...(Object.keys(truncated).length ? { truncated } : {}),
    df,
    projects: projectIds.map((id) => ({ id, key: projectNameKey(id) })).filter((p) => p.key.length >= 4),
    notes
  };
}

// Cache files carry their format version in the name. A development checkout and an installed release
// share ~/.laya/cache; with one file name each rejected the other's version and rebuilt it, every turn.
export const INDEX_CACHE_FILE = `vault-index-v${INDEX_VERSION}.json`;
export const EMBEDDING_CACHE_FILE = `vault-embeddings-v${EMBEDDING_CACHE_VERSION}.bin`;

export function defaultIndexCachePath(options = {}) {
  return cacheFile(INDEX_CACHE_FILE, options);
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
 * Cached index for a Vault. Rebuilds when the Vault path, index version, any scanned directory's mtime,
 * or any scanned note's mtime/size changes, reading again only the files that changed. Every INDEX_TTL_MS
 * it reads every file once more: a file restored with its old mtime and an equal size (`cp -p`, tar)
 * looks unchanged to the incremental rebuild, and this bounds how long such a note can stay stale.
 */
export function loadVaultIndex(vaultPath, { cachePath = defaultIndexCachePath(), now = Date.now(), ttlMs = INDEX_TTL_MS } = {}) {
  if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath)) return null;
  try {
    if (!fs.statSync(path.join(vaultPath, "20-Projects")).isDirectory()) return null;
  } catch {
    return null;
  }
  const cached = readJson(cachePath);
  const usable = cached && cached.version === INDEX_VERSION && cached.vaultPath === vaultPath &&
    Array.isArray(cached.scannedDirs) && Array.isArray(cached.scannedFiles);
  const fresh = usable && now - (cached.fullBuiltAt ?? cached.builtAt) < ttlMs;
  if (
    fresh &&
    directorySignature(cached.scannedDirs) === cached.signature &&
    fileSignature(cached.scannedFiles) === cached.fileSignature
  ) {
    return cached;
  }
  // A change within the TTL: re-read only the changed files. TTL expired: read everything.
  const index = buildVaultIndex(vaultPath, { previous: fresh ? cached : null });
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
export function matchVault(index, text, { projectId = null, thresholds = DEFAULT_VAULT_THRESHOLDS, maxHits = 3, includeDeprecated = false } = {}) {
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
    if (!includeDeprecated && note.deprecated) continue;
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
    scored.push({
      path: note.path,
      projectId: note.projectId,
      pending: Boolean(note.pending),
      ...(note.deprecated ? { deprecated: true } : {}),
      score: Math.round(score * 100) / 100,
      concepts: concepts.length,
      terms: matched
    });
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
  return cacheFile(EMBEDDING_CACHE_FILE, options);
}

// Binary cache layout: "LAYAEMB1", a uint32 header length, a JSON header (version, vaultPath, model, dim,
// builtAt, entries: { path: { hash, o, n } } with o/n in vectors), zero padding to 4 bytes, then the
// vectors as little-endian float32. JSON numbers took ~4 KB and ~4 ms per thousand floats to parse; this
// is a quarter of the size and loads as views into one buffer.
const EMBEDDING_MAGIC = "LAYAEMB1";

/** True for a vector as the retriever returns it (array) or as the cache stores it (Float32Array). */
export function isVector(value) {
  return (Array.isArray(value) || value instanceof Float32Array) && value.length > 0;
}

function readEmbeddingFile(cachePath) {
  let buf;
  try { buf = fs.readFileSync(cachePath); } catch { return null; }
  if (buf.length < 12 || buf.toString("latin1", 0, 8) !== EMBEDDING_MAGIC) {
    // A JSON cache (written before the binary format, or by hand in tests).
    try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
  }
  try {
    const headerLen = buf.readUInt32LE(8);
    const header = JSON.parse(buf.toString("utf8", 12, 12 + headerLen));
    const dataStart = Math.ceil((12 + headerLen) / 4) * 4;
    const floats = Math.floor((buf.length - dataStart) / 4);
    const aligned = (buf.byteOffset + dataStart) % 4 === 0;
    const data = aligned
      ? new Float32Array(buf.buffer, buf.byteOffset + dataStart, floats)
      : new Float32Array(buf.buffer.slice(buf.byteOffset + dataStart, buf.byteOffset + dataStart + floats * 4));
    const dim = header.dim;
    const entries = {};
    for (const [key, e] of Object.entries(header.entries ?? {})) {
      if (!dim || e.o + e.n * dim > floats) continue;
      const vecs = Array.from({ length: e.n }, (_, i) => data.subarray((e.o + i) * dim, (e.o + i + 1) * dim));
      entries[key] = { hash: e.hash, v: vecs[0], ...(vecs.length > 1 ? { chunks: vecs } : {}) };
    }
    return { ...header, entries };
  } catch { return null; }
}

/** Write the cache in the binary layout, atomically. Never throws. */
export function saveEmbeddingCache(cachePath, cache) {
  try {
    const dim = cache.dim;
    const header = { version: cache.version, vaultPath: cache.vaultPath, model: cache.model, dim, builtAt: cache.builtAt ?? Date.now(), entries: {} };
    const parts = [];
    let offset = 0;
    for (const [key, e] of Object.entries(cache.entries ?? {})) {
      const vecs = (Array.isArray(e.chunks) && e.chunks.length ? e.chunks : [e.v]).filter((v) => isVector(v) && v.length === dim);
      if (!dim || vecs.length === 0) continue;
      header.entries[key] = { hash: e.hash, o: offset, n: vecs.length };
      parts.push(...vecs);
      offset += vecs.length;
    }
    const json = Buffer.from(JSON.stringify(header), "utf8");
    const dataStart = Math.ceil((12 + json.length) / 4) * 4;
    const out = Buffer.alloc(dataStart + offset * (dim ?? 0) * 4);
    out.write(EMBEDDING_MAGIC, 0, "latin1");
    out.writeUInt32LE(json.length, 8);
    json.copy(out, 12);
    const data = new Float32Array(out.buffer, out.byteOffset + dataStart, offset * (dim ?? 0));
    parts.forEach((v, i) => data.set(v, i * dim));
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, cachePath);
  } catch {}
}

/** Cached note vectors for one Vault and retriever model; a fresh empty cache when anything differs. */
export function loadEmbeddingCache(cachePath, { vaultPath, model }) {
  const cached = readEmbeddingFile(cachePath);
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

function noteTextsForEmbed(note) {
  if (Array.isArray(note?.embedChunks) && note.embedChunks.length > 0) return note.embedChunks;
  return note?.embedText ? [note.embedText] : [];
}

/**
 * Embed up to `maxNotes` pending texts (grouped by whole note, bounded by `embed` max batch size 32)
 * through `embedFn(texts) -> vectors` and persist the cache. Bounded per call so a hook never spends
 * more than one batch on indexing; the rest follows on the next turns. Entries of notes that left the
 * index are dropped. Returns { embedded, pending }.
 */
export async function ensureVaultEmbeddings(index, cache, embedFn, { cachePath, maxNotes = 32 } = {}) {
  const pending = pendingEmbeddings(index, cache);
  const cap = Math.min(32, Math.max(0, maxNotes));
  const batchNotes = [];
  let totalTexts = 0;
  for (const note of pending) {
    if (cap <= 0) break;
    const rawTexts = noteTextsForEmbed(note);
    if (rawTexts.length === 0) continue;
    const texts = batchNotes.length === 0 ? rawTexts.slice(0, Math.min(rawTexts.length, 32)) : rawTexts;
    if (batchNotes.length > 0 && totalTexts + texts.length > cap) break;
    batchNotes.push({ note, texts });
    totalTexts += texts.length;
    if (totalTexts >= cap) break;
  }

  let embedded = 0;
  if (batchNotes.length > 0) {
    const flatTexts = batchNotes.flatMap((item) => item.texts);
    const vectors = await embedFn(flatTexts);
    if (!Array.isArray(vectors) || vectors.length !== flatTexts.length) throw new TypeError("embedFn returned the wrong number of vectors");
    if (!cache.version) cache.version = EMBEDDING_CACHE_VERSION;
    let offset = 0;
    for (const { note, texts } of batchNotes) {
      const slice = vectors.slice(offset, offset + texts.length);
      offset += texts.length;
      const valid = slice.filter(isVector);
      if (valid.length === 0) continue;
      for (const vec of valid) {
        if (cache.dim && vec.length !== cache.dim) throw new TypeError("embedding size changed");
        cache.dim = vec.length;
      }
      cache.entries[note.path] = {
        hash: note.hash,
        v: valid[0],
        ...(valid.length > 1 ? { chunks: valid } : {})
      };
      embedded++;
    }
  }
  const live = new Set(index.notes.map((note) => note.path));
  let pruned = 0;
  for (const key of Object.keys(cache.entries)) if (!live.has(key)) { delete cache.entries[key]; pruned++; }
  if (embedded > 0 || pruned > 0) {
    cache.builtAt = Date.now();
    if (cachePath) saveEmbeddingCache(cachePath, cache);
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
 * Multi-chunk notes score by the maximum cosine across their chunks so each note keeps one candidate slot.
 * Returns { strength: "none"|"weak"|"strong", top, prominence, candidates, hits: [{ path, projectId, pending, deprecated?, score }] }.
 * Candidate notes follow matchVault's scoping: with a known projectId, that project's and global
 * notes, plus projects the prompt names. Prominence is undefined below MIN_SEMANTIC_CANDIDATES.
 */
export function matchVaultSemantic(index, cache, queryVector, { projectId = null, mentionedProjects = [], thresholds = DEFAULT_SEMANTIC_THRESHOLDS, maxHits = 3, includeDeprecated = false } = {}) {
  const empty = { strength: "none", top: 0, prominence: 0, candidates: 0, hits: [] };
  if (!index?.notes?.length || !cache?.entries || !Array.isArray(queryVector) || queryVector.length === 0) return empty;
  // A resolved project always limits the candidates to itself, Global and projects the prompt names,
  // even when it has no notes yet: other private projects never leak into its hints.
  const scoped = Boolean(projectId);
  const scored = [];
  const background = [];
  for (const note of index.notes) {
    if (!includeDeprecated && note.deprecated) continue;
    const entry = cache.entries[note.path];
    if (!entry || entry.hash !== note.hash) continue;
    const rawVecs = Array.isArray(entry.chunks) && entry.chunks.length ? entry.chunks : (isVector(entry.v) ? [entry.v] : []);
    const vecs = rawVecs.filter((v) => isVector(v) && v.length === queryVector.length);
    if (vecs.length === 0) continue;
    let score = -Infinity;
    for (const v of vecs) {
      const s = dot(v, queryVector);
      if (s > score) score = s;
    }
    background.push(score);
    if (scoped && note.projectId !== "global" && note.projectId !== projectId && !mentionedProjects.includes(note.projectId)) continue;
    scored.push({
      path: note.path,
      projectId: note.projectId,
      pending: Boolean(note.pending),
      ...(note.deprecated ? { deprecated: true } : {}),
      score
    });
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

/**
 * Map a working directory to a project id using 00-System/projects.yaml: the longest registered root,
 * else the one project whose `remotes` include the directory's Git remote (the same repository checked
 * out at another path, e.g. on another machine that shares this Vault). See lib/vault-transfer/projects.js.
 */
export function resolveProjectIdFromCwd(vaultPath, cwd) {
  if (typeof cwd !== "string" || !cwd || typeof vaultPath !== "string") return null;
  const text = readHead(path.join(vaultPath, "00-System", "projects.yaml"), 65536);
  if (!text) return null;
  return resolveProject(parseProjectsYaml(text), cwd)?.id ?? null;
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
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const candidates = ruleFiles ?? [
    path.join(codexHome, "AGENTS.override.md"),
    path.join(codexHome, "AGENTS.md"),
    path.join(claudeHome, "CLAUDE.md"),
    path.join(home, ".gemini", "GEMINI.md")
  ];
  for (const file of candidates) {
    const value = vaultPathFromRuleText(readHead(file, 262144));
    if (value) return value;
  }
  return null;
}
