/**
 * LLM extraction for the session digest (experimental, 0.9): instead of picking turns by conclusion words
 * and Laya scores, give a model the whole finished session and ask what is still worth knowing in a later
 * session. The model runs through the host's own CLI (the user's existing login), with this plugin's hooks
 * off so the call is never captured itself.
 *
 * The model only proposes; the digest's hard rules (Vault initialized, scope, opt-out, no credentials,
 * template, cand-<uuid>) still apply to whatever it returns.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { containsSensitiveContent } from "./fast-path.js";

export const EXTRACT_KINDS = ["decision", "convention", "preference", "pitfall", "fact"];
// Items per session grow with its length: the 2026-10 replay found the old flat cap of 3 binding in 10 of 84
// sessions, all long ones, while short sessions rarely had more than one thing worth keeping.
export const MAX_EXTRACTED_ITEMS = 5;
export function maxItemsFor(turnCount) {
  return turnCount >= 20 ? 5 : turnCount >= 8 ? 4 : 3;
}
const PROMPT_MAX_CHARS = 1500;
const REPLY_MAX_CHARS = 3000;
// A longer session is extracted in parts of about this size and the parts' items merged in one more call:
// one pass over 30k+ characters skimmed the middle of the session.
export const PART_MAX_CHARS = 30000;

// Strict structured-output schema (every property required, no extras), accepted by `codex exec --output-schema`.
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: MAX_EXTRACTED_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "scope", "title", "statement", "evidence", "turn"],
        properties: {
          kind: { type: "string", enum: EXTRACT_KINDS },
          scope: { type: "string", enum: ["project", "global"] },
          title: { type: "string" },
          statement: { type: "string" },
          evidence: { type: "string" },
          turn: { type: "integer" }
        }
      }
    }
  }
};

const RULES = `Keep only knowledge that will still be true and useful in a LATER session and that a future agent could not easily get from the code, git history or docs. In order of value:
- decision: a choice the user made or approved, with its reason: product scope, what to build or not build, architecture, which tool/host/approach, who does what.
- convention: how the user wants work done here from now on: workflow, release/test/install steps, what the agent must or must not do, naming, what not to touch.
- preference: something about the user themselves that holds across projects (language, tone, how they like to work) -> scope "global".
- fact: a durable fact about the user's setup or environment that a future agent needs (where something lives, which account/host/version is used and why).
- pitfall: only when it is likely to happen again in future work AND the code does not show it (a host/library behavior that will bite the next change too). A gotcha met once while debugging or verifying, an environment hiccup, or a bug whose fix now lives in the code is NOT a pitfall worth keeping.

Do NOT keep:
- progress or status reports: what was done this turn, tests passed, version built/released, files changed, commits, "deployed".
- ordinary bug fixes and their root causes once the fix is in the code.
- the user's requests, bug reports and questions themselves ("X 不显示了", "帮我看一下"): they describe a current problem, not a lasting fact. But a rule or decision the user states while asking ("不要修 iOS 了，只做小程序") IS worth keeping.
- general knowledge any engineer has, or answers to general questions.
- anything the session later revised or reverted: use the final state only.
- credentials, tokens, personal identifiers.`;

const ITEM_FORMAT = `For each item:
- statement: 1-3 sentences, self-contained: someone reading it months later without this session must understand it. Name the concrete things (project parts, files, hosts, commands, versions). Write it in the language the user writes in.
- title: a short noun phrase (<= 60 characters), same language.
- evidence: a short verbatim quote (<= 200 characters) from the session that supports it.
- turn: the number of the turn the evidence comes from.
- scope: "project" unless it is about the user personally across all work.

Answer with JSON only, matching the given schema.`;

const instructions = (limit) => `You review a finished chat session between a user and an AI coding/assistant agent and decide what, if anything, belongs in the user's long-term memory (an Obsidian Vault that future agent sessions read before working on this project).

${RULES}

Most sessions contain little worth keeping: an empty list is a normal answer. Return at most ${limit} items, the most valuable first, and merge items about the same thing.

${ITEM_FORMAT}`;

function cut(text, max) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)} …[truncated]` : t;
}

function turnBlock(t, n) {
  const request = t.continued ? "(no new message: the agent continued the previous request)" : cut(t.prompt, PROMPT_MAX_CHARS) || "(not recorded)";
  return `### Turn ${n} (${t.ts ?? "?"})\nUser:\n${request}\n\nAgent (final reply):\n${cut(t.reply, REPLY_MAX_CHARS)}\n`;
}

/**
 * Split a session into parts of at most `maxChars` of turn text (a single longer turn is a part of its own).
 * Returns [{ first: 1-based number of the part's first turn, blocks: [text] }].
 */
export function splitSession(turns, maxChars = PART_MAX_CHARS) {
  const parts = [];
  let cur = null;
  turns.forEach((t, i) => {
    const block = turnBlock(t, i + 1);
    if (!cur || (cur.size + block.length > maxChars && cur.blocks.length)) parts.push(cur = { first: i + 1, blocks: [], size: 0 });
    cur.blocks.push(block);
    cur.size += block.length;
  });
  return parts.map(({ first, blocks }) => ({ first, blocks }));
}

function sessionLine({ host = "host", projectId = null, turns = [] }) {
  return `Session: ${host} session${projectId ? `, project "${projectId}"` : ", no project bound"}, ${turns.length} turns.`;
}

/**
 * The extraction prompt for one session (or one part of it): { host, projectId, turns: [{ ts, prompt, reply,
 * continued? }] }. `part` = { index, count, first, blocks } from splitSession; without it the whole session.
 */
export function buildExtractionPrompt(session = {}, { limit = maxItemsFor(session.turns?.length ?? 0), part = null } = {}) {
  const turns = session.turns ?? [];
  const blocks = part ? part.blocks : turns.map((t, i) => turnBlock(t, i + 1));
  const where = part && part.count > 1
    ? [`This is part ${part.index} of ${part.count} of the session (turns ${part.first}-${part.first + part.blocks.length - 1}). Later parts may revise what this part concludes; still report what this part establishes.`, ""]
    : [];
  return [instructions(limit), "", sessionLine(session), ...where, "", "<session>", ...blocks, "</session>"].join("\n");
}

/**
 * The merge prompt for a session extracted in parts: the parts' items (with their turn numbers) are merged,
 * duplicates combined, items a later turn revised dropped, and at most `limit` kept.
 */
export function buildMergePrompt(session = {}, items = [], { limit = maxItemsFor(session.turns?.length ?? 0) } = {}) {
  const list = items.map((it, i) => `${i + 1}. [${it.kind}, ${it.scope}, turn ${it.turn ?? "?"}] ${it.title}\n   ${it.statement}\n   Evidence: "${it.evidence}"`);
  return [
    "A long chat session was reviewed in parts for the user's long-term memory (an Obsidian Vault that future agent sessions read). These are the items proposed from each part, in session order.",
    "",
    RULES,
    "",
    `Produce the final list for the whole session: merge items about the same thing into one (keep the most specific wording and the latest evidence), drop an item when a later item revises or contradicts it, drop items that fail the rules above, and keep at most ${limit} items, the most valuable first. Do not invent anything that is not in these items.`,
    "",
    ITEM_FORMAT,
    "",
    sessionLine(session),
    "",
    "<items>", ...list, "</items>"
  ].join("\n");
}

/**
 * Extract one session with `run(prompt) -> model text` (a host runner bound to its options). A session that
 * fits one part takes one call; a longer one takes one call per part plus a merge call. Resolves to
 * { items, dropped, calls }; throws when a call fails or answers garbage (the digest retries later).
 */
export async function extractSession(session, run, { maxChars = PART_MAX_CHARS } = {}) {
  const turnCount = session.turns?.length ?? 0;
  const limit = maxItemsFor(turnCount);
  const parts = splitSession(session.turns ?? [], maxChars);
  if (parts.length <= 1) {
    const out = parseExtraction(await run(buildExtractionPrompt(session, { limit })), { turnCount, limit });
    return { ...out, calls: 1 };
  }
  const found = [];
  const dropped = [];
  for (const [i, part] of parts.entries()) {
    const out = parseExtraction(await run(buildExtractionPrompt(session, { limit: 3, part: { ...part, index: i + 1, count: parts.length } })), { turnCount, limit: 3 });
    found.push(...out.items);
    dropped.push(...out.dropped);
  }
  if (found.length === 0) return { items: [], dropped, calls: parts.length };
  const merged = parseExtraction(await run(buildMergePrompt(session, found, { limit })), { turnCount, limit });
  return { items: merged.items, dropped: [...dropped, ...merged.dropped], calls: parts.length + 1 };
}

/**
 * Validate a model answer. Returns { items, dropped } where items are well-formed, non-empty, credential
 * free and at most `limit`; anything else is dropped with a reason. Throws on unparsable JSON.
 */
export function parseExtraction(text, { turnCount = Infinity, limit = MAX_EXTRACTED_ITEMS } = {}) {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/gu, "");
  const data = JSON.parse(raw);
  const list = Array.isArray(data?.items) ? data.items : [];
  const items = [];
  const dropped = [];
  for (const it of list) {
    const statement = typeof it?.statement === "string" ? it.statement.trim() : "";
    if (!statement || !EXTRACT_KINDS.includes(it.kind)) { dropped.push("malformed"); continue; }
    const item = {
      kind: it.kind,
      scope: it.scope === "global" ? "global" : "project",
      title: (typeof it.title === "string" && it.title.trim() ? it.title.trim() : statement).slice(0, 80),
      statement: statement.slice(0, 1200),
      evidence: typeof it.evidence === "string" ? it.evidence.trim().slice(0, 400) : "",
      turn: Number.isInteger(it.turn) && it.turn >= 1 && it.turn <= turnCount ? it.turn : null
    };
    if (containsSensitiveContent(`${item.title}\n${item.statement}\n${item.evidence}`)) { dropped.push("sensitive_content"); continue; }
    if (items.length >= limit) { dropped.push("over_limit"); continue; }
    items.push(item);
  }
  return { items, dropped };
}

// ---------------------------------------------------------------- host runners

/** Codex CLI: the desktop app's bundled binary first (the npm one on PATH is often broken), then PATH. */
export function resolveCodexBin(env = process.env) {
  const candidates = [
    env.CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex"
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? "codex";
}

/** The user's configured Codex model and effort (top-level keys of $CODEX_HOME/config.toml), if any. */
export function codexUserModel(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  let text = "";
  try { text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"); } catch { return {}; }
  const top = text.split(/^\[/mu)[0];
  const value = (key) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "mu").exec(top)?.[1] ?? null;
  return { model: value("model"), effort: value("model_reasoning_effort") };
}

/**
 * One extraction through `codex exec`: ephemeral (no session file), read-only sandbox in an empty folder,
 * without the user's config (no MCP servers, no plugins), hooks off, and this plugin's router off in case a
 * hook still runs. Resolves to the model's final message text.
 */
export function runCodexExtraction(prompt, { codexBin = resolveCodexBin(), model = null, effort = null, timeoutMs = 240000, env = process.env } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "om-extract-"));
  const schemaFile = path.join(work, "schema.json");
  const outFile = path.join(work, "out.txt");
  fs.writeFileSync(schemaFile, JSON.stringify(EXTRACTION_SCHEMA));
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "-s", "read-only", "--disable", "hooks", "--disable", "plugins", "-C", work,
    "--output-schema", schemaFile, "-o", outFile, "--color", "never",
    ...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []), "-"];
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: work, stdio: ["pipe", "ignore", "pipe"],
      env: { ...env, OBSIDIAN_MEMORY_JUDGE_MODE: "off", OBSIDIAN_MEMORY_DIGEST: "off", OBSIDIAN_MEMORY_AUTO_CAPTURE: "off" }
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let out = "";
      try { out = fs.readFileSync(outFile, "utf8"); } catch {}
      fs.rmSync(work, { recursive: true, force: true });
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(`codex exec exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
    child.stdin.end(prompt);
  });
}

/** Hermes CLI on PATH or in its default install folder. */
export function resolveHermesBin(env = process.env) {
  const dirs = [...String(env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(env.HOME || os.homedir(), ".local", "bin")];
  const candidates = [env.HERMES_BIN, ...dirs.map((d) => path.join(d, "hermes"))].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

/**
 * One extraction through `hermes -z` (one-shot: prints only the final answer), project rules ignored and this
 * plugin's router off. Hermes has no output schema; parseExtraction validates the JSON it returns.
 */
export function runHermesExtraction(prompt, { hermesBin = resolveHermesBin(), timeoutMs = 240000, env = process.env } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "om-extract-"));
  return new Promise((resolve, reject) => {
    const child = spawn(hermesBin, ["-z", prompt, "--ignore-rules"], {
      cwd: work, stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, OBSIDIAN_MEMORY_JUDGE_MODE: "off", OBSIDIAN_MEMORY_DIGEST: "off", OBSIDIAN_MEMORY_AUTO_CAPTURE: "off" }
    });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(work, { recursive: true, force: true });
      // Keep the JSON object even if the CLI printed something around it.
      const json = /\{[\s\S]*\}/u.exec(out)?.[0];
      if (code === 0 && json) resolve(json);
      else reject(new Error(`hermes -z exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

export const EXTRACTORS = ["auto", "codex", "hermes", "off"];

/**
 * The extractor this machine uses for every host's sessions (OpenClaw's own one-shot inference and
 * Antigravity have no usable CLI call, and one model keeps candidates consistent): `preference` "auto" tries
 * Codex (the one the 2026-10 replay validated: logged in, desktop app or CLI present), then Hermes. Returns
 * { name, model, run(prompt) } or null ("off", or nothing installed: the digest then uses its keyword
 * selection).
 */
export function resolveExtractor({ preference = "auto", env = process.env, codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
  if (preference === "off") return null;
  const tryCodex = () => {
    const codexBin = resolveCodexBin(env);
    if (codexBin === "codex" || !fs.existsSync(path.join(codexHome, "auth.json"))) return null;
    const { model, effort } = codexUserModel(codexHome);
    return { name: "codex", model: model ?? null, run: (prompt) => runCodexExtraction(prompt, { codexBin, model, effort, env }) };
  };
  const tryHermes = () => {
    const hermesBin = resolveHermesBin(env);
    return hermesBin ? { name: "hermes", model: null, run: (prompt) => runHermesExtraction(prompt, { hermesBin, env }) } : null;
  };
  if (preference === "codex") return tryCodex();
  if (preference === "hermes") return tryHermes();
  return tryCodex() ?? tryHermes();
}
