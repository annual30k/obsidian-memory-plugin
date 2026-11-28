/**
 * Which host ran a shared command hook (scripts/codex-hook.mjs, scripts/codex-stop-hook.mjs).
 *
 * Codex and Claude Code load the same hooks/hooks.json and send nearly the same payload, so the host is
 * told apart by where its transcript lives (~/.codex/sessions vs ~/.claude/projects, or the directory a
 * CODEX_HOME / CLAUDE_CONFIG_DIR points to), then by Claude Code's own hook environment
 * (CLAUDE_PROJECT_DIR, which Codex does not set). The answer is only a label for session state, logs and
 * captured candidates ("claude session …"); both hosts get the same behaviour.
 */
import path from "node:path";

const norm = (p) => String(p).replace(/\\/gu, "/").toLowerCase();

function under(file, dir) {
  if (!dir) return false;
  const d = norm(path.resolve(dir)).replace(/\/+$/u, "");
  return norm(file).startsWith(`${d}/`);
}

export function hookHost(payload, env = process.env) {
  const transcript = typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
  if (transcript) {
    if (under(transcript, env.CLAUDE_CONFIG_DIR?.trim())) return "claude";
    if (under(transcript, env.CODEX_HOME?.trim())) return "codex";
    const t = norm(transcript);
    if (t.includes("/.claude/")) return "claude";
    if (t.includes("/.codex/")) return "codex";
  }
  if (env.CLAUDE_PROJECT_DIR?.trim()) return "claude";
  return "codex";
}
