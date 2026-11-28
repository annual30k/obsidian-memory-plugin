/**
 * Fine-grained per-project filtering for ~/.laya/labels*.jsonl during export and import.
 *
 * Each JSONL row may carry optional `project_id` (or `projectId`) and `scope` ("global" | "project").
 * Legacy rows without attribution are handled conservatively: whenever a project/global restriction
 * is active (e.g. `transfer: local`, `--project`, `--only-project`, `--skip-project`, `--no-global`),
 * unattributed rows are dropped by default so private prompts from excluded projects never leak.
 */

export function labelProjectId(row) {
  if (!row || typeof row !== "object") return null;
  if (typeof row.project_id === "string" && row.project_id.trim()) return row.project_id.trim();
  if (typeof row.projectId === "string" && row.projectId.trim()) return row.projectId.trim();
  return null;
}

export function labelScope(row) {
  if (!row || typeof row !== "object") return null;
  return typeof row.scope === "string" && row.scope.trim() ? row.scope.trim().toLowerCase() : null;
}

/**
 * Filter a JSONL labels text according to project/global allow/deny rules.
 * Options:
 *   allowProjects     Set<string> | null  — whitelist (if non-null, only these project_ids or global allowed)
 *   excludeProjects   Set<string>         — blacklist (transfer: local or --skip-project)
 *   includeGlobal     boolean             — whether `scope: "global"` rows are kept (default true)
 *   keepUnattributed  boolean             — whether legacy rows without project_id/scope are kept
 *
 * Returns { text, kept, droppedProject, droppedScope, droppedUnattributed, total }.
 */
export function filterLayaLabels(text, {
  allowProjects = null,
  excludeProjects = new Set(),
  includeGlobal = true,
  keepUnattributed = true
} = {}) {
  const allow = allowProjects instanceof Set ? allowProjects : (Array.isArray(allowProjects) ? new Set(allowProjects) : null);
  const exclude = excludeProjects instanceof Set ? excludeProjects : new Set(excludeProjects ?? []);
  const lines = String(text ?? "").split(/\r?\n/u).filter((l) => l.trim());
  const keptLines = [];
  let droppedProject = 0;
  let droppedScope = 0;
  let droppedUnattributed = 0;

  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch {
      if (keepUnattributed && !allow && exclude.size === 0) keptLines.push(line);
      else droppedUnattributed++;
      continue;
    }
    const pid = labelProjectId(row);
    const scope = labelScope(row);
    if (pid) {
      if (exclude.has(pid) || (allow && !allow.has(pid))) {
        droppedProject++;
        continue;
      }
      keptLines.push(line);
      continue;
    }
    if (scope === "global") {
      if (!includeGlobal) {
        droppedScope++;
        continue;
      }
      keptLines.push(line);
      continue;
    }
    // Unattributed legacy row (no project_id and not explicitly global).
    if (!keepUnattributed) {
      droppedUnattributed++;
      continue;
    }
    keptLines.push(line);
  }

  return {
    text: keptLines.length ? keptLines.join("\n") + "\n" : "",
    kept: keptLines.length,
    droppedProject,
    droppedScope,
    droppedUnattributed,
    total: lines.length
  };
}
