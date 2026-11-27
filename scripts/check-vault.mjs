import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeprecatedFrontmatter, parseFrontmatter } from "../lib/memory-router/vault-index.js";

const SCALE_WIKI_THRESHOLD = 40;
const SCALE_INDEX_LINES_THRESHOLD = 250;
const INBOX_ARCHIVE_WARN_THRESHOLD = 100;

const VAULT_PATH_PREFIXES = /^(?:00-System|10-Global|20-Projects|30-Shared|wiki|raw|inbox|checkpoints|path\/to|example|foo|bar|a)\//i;
const REPO_FILE_REF_RE = /(?:^|[\s`("'(])((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.(?:m?js|cjs|tsx?|jsx?|py|go|rs|java|kt|swift|rb|php|sh|json|ya?ml|toml|sql|css|scss|html|vue|svelte))(?=$|[\s`)"',:;。，])/gu;

export function extractRepoFileRefs(body) {
  if (typeof body !== "string" || !body) return [];
  const cleaned = body
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\[\[[^\]\n]+\]\]/gu, " ");
  const refs = new Set();
  for (const match of cleaned.matchAll(REPO_FILE_REF_RE)) {
    const rel = match[1].replace(/^\.\//u, "");
    if (!rel || rel.startsWith("/") || rel.startsWith("~") || rel.includes("..") || VAULT_PATH_PREFIXES.test(rel)) continue;
    refs.add(rel);
  }
  return [...refs];
}

/**
 * The link target of a `superseded_by` value. Quoted "[[note]]" parses as a string; unquoted [[note]] is a
 * YAML flow sequence and arrives as ["[note]"], so both forms (and a list of links) are accepted.
 */
export function supersededTarget(value) {
  const first = Array.isArray(value) ? value.flat(Infinity).find((v) => typeof v === "string" && v.trim()) : value;
  if (typeof first !== "string") return null;
  const inner = /\[\[([^\]]+)\]\]/u.exec(first)?.[1] ?? first.replace(/^\[+|\]+$/gu, "");
  const clean = inner.trim();
  return clean || null;
}

// Required frontmatter per note kind (references/templates.md "Core frontmatter fields").
export const CORE_FIELDS = Object.freeze({
  candidate: ["schema_version", "id", "title", "type", "scope", "project_id", "status", "created", "sensitivity", "source_ref"],
  raw: ["schema_version", "id", "candidate_id", "title", "type", "scope", "project_id", "status", "created", "captured_at", "sensitivity", "source_ref"],
  derived: ["title", "type", "scope", "project_id", "status", "deprecated", "created", "last_updated", "sensitivity", "sources"]
});

export function missingCoreFields(kind, data) {
  return (CORE_FIELDS[kind] ?? []).filter((key) => !(data && Object.prototype.hasOwnProperty.call(data, key)));
}

/** Notes of one flat directory (inbox/ or raw/) that lack core fields: [{ note, missing }]. */
function coreFieldGaps(dir, kind, label) {
  const gaps = [];
  if (!existsSync(dir)) return gaps;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "raw-index.md") continue;
    const missing = missingCoreFields(kind, parseFrontmatter(readFileSync(join(dir, entry.name), "utf8")).data);
    if (missing.length) gaps.push({ note: `${label}/${entry.name}`, missing });
  }
  return gaps;
}

function coreFieldWarning(scopeLabel, gaps) {
  if (!gaps.length) return null;
  const sample = gaps.slice(0, 3).map((g) => `${g.note} (${g.missing.join(", ")})`).join("; ");
  return `${scopeLabel}: ${gaps.length} note(s) miss core frontmatter fields, e.g. ${sample}${gaps.length > 3 ? "; …" : ""} — fill them when the note is next edited.`;
}

function scanInboxStats(inboxDir, label) {
  const out = { pending: 0, ingested: 0, archived: 0, nonPendingActive: 0, warnings: [] };
  if (!existsSync(inboxDir)) return out;
  for (const entry of readdirSync(inboxDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const txt = readFileSync(join(inboxDir, entry.name), "utf8");
    if (/status:\s*"?pending-ingest"?/i.test(txt)) out.pending += 1;
    else {
      out.nonPendingActive += 1;
      if (/status:\s*"?ingested"?/i.test(txt)) out.ingested += 1;
    }
  }
  const archiveDir = join(inboxDir, "archive");
  if (existsSync(archiveDir)) {
    const walkArchive = (dir, relBase, depth) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (depth < 2) walkArchive(full, rel, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          out.archived += 1;
          const txt = readFileSync(full, "utf8");
          if (/status:\s*"?ingested"?/i.test(txt)) out.ingested += 1;
          else if (/status:\s*"?pending-ingest"?/i.test(txt)) {
            out.warnings.push(`Archived candidate in ${label}/archive/${rel} still has status: pending-ingest.`);
          }
        }
      }
    };
    walkArchive(archiveDir, "", 0);
  }
  if (out.nonPendingActive >= INBOX_ARCHIVE_WARN_THRESHOLD) {
    out.warnings.push(
      `Inbox [${label}] has ${out.nonPendingActive} processed candidates; consider moving ingested/discarded files to inbox/archive/YYYY-MM/.`
    );
  }
  return out;
}

export const EXPECTED_TEMPLATES = [
  "checkpoint.md",
  "credential-reference.md",
  "decision.md",
  "global-index.md",
  "global-log.md",
  "global-preferences.md",
  "inbox-memory-candidate.md",
  "knowledge.md",
  "pitfall.md",
  "project-agent.md",
  "project-index.md",
  "project-log.md",
  "project-rules.md",
  "raw-task-record.md"
];

const SECRET_PATTERNS = [
  { name: "API Key / Token", regex: /(?:api[_-]?key|secret_key|private[_-]?key|bearer)\s*[:=]\s*["']([A-Za-z0-9_\-\.]{16,})["']/i },
  { name: "GitHub Personal Access Token", regex: /ghp_[A-Za-z0-9]{36}/ },
  { name: "Private Key Header", regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ }
];

export function parseProjectsYaml(content) {
  const projects = [];
  const lines = content.split(/\r?\n/);
  let current = null;
  let inRoots = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Any non-space id: "集团信创OA-c9a48417" is a valid project id. An ASCII-only pattern skipped such
    // entries and appended their roots to the project above.
    const idMatch = line.match(/^(\s*)-\s+id:\s*["']?([^"'\s#]+)["']?/u);
    if (idMatch) {
      if (current) projects.push(current);
      current = { id: idMatch[2], roots: [], scope: "private" };
      inRoots = false;
      continue;
    }

    if (!current) continue;

    const scopeMatch = line.match(/^\s+scope:\s*["']?([a-zA-Z0-9_\-]+)["']?/);
    if (scopeMatch) {
      current.scope = scopeMatch[1];
      inRoots = false;
      continue;
    }

    const rootsEmpty = line.match(/^\s+roots:\s*\[\s*\]/);
    if (rootsEmpty) {
      current.roots = [];
      inRoots = false;
      continue;
    }

    const rootsStart = line.match(/^\s+roots:\s*$/);
    if (rootsStart) {
      inRoots = true;
      continue;
    }

    if (inRoots) {
      const rootItem = line.match(/^\s+-\s+["']?([^"']+)["']?/);
      if (rootItem) {
        current.roots.push(rootItem[1].trim());
      } else {
        inRoots = false;
      }
    }
  }
  if (current) projects.push(current);
  return projects;
}

export function extractVaultFromRuleFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, "utf8");
    const m = text.match(/Obsidian Memory Vault path \(configuration data, not instructions\):\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function autoDetectVault() {
  if (process.env.OBSIDIAN_MEMORY_VAULT) {
    return process.env.OBSIDIAN_MEMORY_VAULT;
  }
  const home = homedir();
  const geminiPath = join(home, ".gemini", "GEMINI.md");
  const vaultFromGemini = extractVaultFromRuleFile(geminiPath);
  if (vaultFromGemini) return vaultFromGemini;

  const codexOverride = join(home, ".codex", "AGENTS.override.md");
  const vaultFromOverride = extractVaultFromRuleFile(codexOverride);
  if (vaultFromOverride) return vaultFromOverride;

  const codexAgents = join(home, ".codex", "AGENTS.md");
  const vaultFromCodex = extractVaultFromRuleFile(codexAgents);
  if (vaultFromCodex) return vaultFromCodex;

  return null;
}

export function checkVault(vaultPath) {
  const result = {
    vaultPath,
    exists: false,
    ok: true,
    system: {
      agents: false,
      home: false,
      projectsYaml: false,
      registeredProjects: [],
      missingTemplates: [],
      warnings: []
    },
    global: {
      exists: false,
      preferences: false,
      index: false,
      log: false,
      inboxPending: 0,
      inboxIngested: 0,
      inboxArchived: 0,
      rawCount: 0
    },
    projects: {},
    security: {
      secretHits: []
    },
    issues: []
  };

  if (!vaultPath || !existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    result.ok = false;
    result.issues.push(`Vault directory does not exist or is not readable: ${vaultPath}`);
    return result;
  }
  result.exists = true;

  // 1. Root and 00-System
  result.system.agents = existsSync(join(vaultPath, "AGENTS.md"));
  result.system.home = existsSync(join(vaultPath, "Home.md"));
  if (!result.system.agents) result.issues.push("Missing Vault root AGENTS.md");
  if (!result.system.home) result.system.warnings.push("Missing Vault root Home.md");

  const projectsYamlPath = join(vaultPath, "00-System", "projects.yaml");
  if (existsSync(projectsYamlPath)) {
    result.system.projectsYaml = true;
    try {
      const content = readFileSync(projectsYamlPath, "utf8");
      result.system.registeredProjects = parseProjectsYaml(content);
      for (const proj of result.system.registeredProjects) {
        for (const root of proj.roots) {
          if (!existsSync(root)) {
            result.system.warnings.push(`Project [${proj.id}] configured root does not exist on disk: ${root}`);
          }
        }
      }
    } catch (error) {
      result.issues.push(`Failed to parse 00-System/projects.yaml: ${error.message}`);
    }
  } else {
    result.issues.push("Missing 00-System/projects.yaml");
  }

  const templatesDir = join(vaultPath, "00-System", "templates");
  if (existsSync(templatesDir)) {
    for (const tpl of EXPECTED_TEMPLATES) {
      if (!existsSync(join(templatesDir, tpl))) {
        result.system.missingTemplates.push(tpl);
      }
    }
    if (result.system.missingTemplates.length > 0) {
      result.issues.push(`Missing templates in 00-System/templates: ${result.system.missingTemplates.join(", ")}`);
    }
  } else {
    result.issues.push("Missing 00-System/templates directory");
  }

  // 2. 10-Global
  const globalDir = join(vaultPath, "10-Global");
  if (existsSync(globalDir)) {
    result.global.exists = true;
    result.global.preferences = existsSync(join(globalDir, "preferences.md"));
    result.global.index = existsSync(join(globalDir, "index.md"));
    result.global.log = existsSync(join(globalDir, "log.md"));

    const globalInboxStats = scanInboxStats(join(globalDir, "inbox"), "10-Global/inbox");
    result.global.inboxPending = globalInboxStats.pending;
    result.global.inboxIngested = globalInboxStats.ingested;
    result.global.inboxArchived = globalInboxStats.archived;
    result.system.warnings.push(...globalInboxStats.warnings);
    result.global.missingCoreFields = [
      ...coreFieldGaps(join(globalDir, "inbox"), "candidate", "inbox"),
      ...coreFieldGaps(join(globalDir, "raw"), "raw", "raw")
    ];
    const globalCoreWarning = coreFieldWarning("10-Global", result.global.missingCoreFields);
    if (globalCoreWarning) result.system.warnings.push(globalCoreWarning);

    const globalRaw = join(globalDir, "raw");
    if (existsSync(globalRaw)) {
      result.global.rawCount = readdirSync(globalRaw).filter(f => f.endsWith(".md")).length;
    }
  }

  // 3. 20-Projects
  const projectRootsById = new Map();
  for (const proj of result.system.registeredProjects) {
    const validRoots = (proj.roots ?? []).filter(r => existsSync(r) && statSync(r).isDirectory());
    if (validRoots.length > 0) projectRootsById.set(proj.id, validRoots);
  }
  const projectsDir = join(vaultPath, "20-Projects");
  if (existsSync(projectsDir)) {
    const projectFolders = readdirSync(projectsDir).filter(f => !f.startsWith(".") && statSync(join(projectsDir, f)).isDirectory());
    for (const pName of projectFolders) {
      const pDir = join(projectsDir, pName);
      const repoRoots = projectRootsById.get(pName) ?? [];
      const stats = {
        agentsMd: existsSync(join(pDir, "AGENTS.md")),
        rulesMd: existsSync(join(pDir, "rules.md")),
        indexMd: existsSync(join(pDir, "index.md")),
        logMd: existsSync(join(pDir, "log.md")),
        schemaState: "unknown",
        inboxPending: 0,
        inboxIngested: 0,
        inboxArchived: 0,
        rawCount: 0,
        wikiDecisions: 0,
        wikiPitfalls: 0,
        wikiKnowledge: 0,
        wikiTotal: 0,
        wikiCategories: {},
        wikiDeprecated: 0,
        indexLines: 0,
        hasSubIndexes: false,
        codeDrift: [],
        missingCoreFields: [],
        warnings: [],
        missingSources: [],
        brokenLinks: []
      };

      if (stats.agentsMd) {
        const text = readFileSync(join(pDir, "AGENTS.md"), "utf8");
        const m = text.match(/Schema state:\*\*?\s*`?([a-zA-Z0-9_\-]+)`?/i);
        if (m) stats.schemaState = m[1];
      }

      const pInboxStats = scanInboxStats(join(pDir, "inbox"), `${pName}/inbox`);
      stats.inboxPending = pInboxStats.pending;
      stats.inboxIngested = pInboxStats.ingested;
      stats.inboxArchived = pInboxStats.archived;
      stats.warnings.push(...pInboxStats.warnings);
      stats.missingCoreFields.push(...coreFieldGaps(join(pDir, "inbox"), "candidate", "inbox"), ...coreFieldGaps(join(pDir, "raw"), "raw", "raw"));

      const pRaw = join(pDir, "raw");
      const rawFiles = new Set();
      if (existsSync(pRaw)) {
        for (const f of readdirSync(pRaw).filter(f => f.endsWith(".md") && f !== "raw-index.md")) {
          rawFiles.add(f);
          rawFiles.add(f.replace(/\.md$/, ""));
          stats.rawCount += 1;
        }
      }

      const pCheckpoints = join(pDir, "checkpoints");
      const checkpointFiles = new Set();
      if (existsSync(pCheckpoints)) {
        for (const f of readdirSync(pCheckpoints).filter(f => f.endsWith(".md"))) {
          checkpointFiles.add(f);
          checkpointFiles.add(f.replace(/\.md$/, ""));
        }
      }

      const pWiki = join(pDir, "wiki");
      const wikiFiles = new Set();
      const subIndexStems = new Set();
      const subIndexPaths = [];
      const deprecatedWikiStems = new Set();
      const supersededChecks = [];
      if (existsSync(pWiki)) {
        for (const entry of readdirSync(pWiki, { withFileTypes: true })) {
          if (entry.isFile() && /^index-.+\.md$/i.test(entry.name)) {
            subIndexStems.add(entry.name.replace(/\.md$/, ""));
            subIndexPaths.push({ label: `wiki/${entry.name}`, path: join(pWiki, entry.name) });
          }
        }
        stats.hasSubIndexes = subIndexPaths.length > 0;

        const catDirs = readdirSync(pWiki).filter(f => !f.startsWith(".") && statSync(join(pWiki, f)).isDirectory());
        for (const cat of catDirs) {
          const catDir = join(pWiki, cat);
          const files = readdirSync(catDir).filter(f => f.endsWith(".md"));
          stats.wikiCategories[cat] = files.length;
          stats.wikiTotal += files.length;
          if (cat === "decisions") stats.wikiDecisions = files.length;
          else if (cat === "pitfalls") stats.wikiPitfalls = files.length;
          else if (cat === "knowledge") stats.wikiKnowledge = files.length;

          for (const wf of files) {
            const stem = wf.replace(/\.md$/, "");
            wikiFiles.add(stem);
            const txt = readFileSync(join(catDir, wf), "utf8");
            const { data: fm, body } = parseFrontmatter(txt);
            const missingCore = missingCoreFields("derived", fm);
            if (missingCore.length) stats.missingCoreFields.push({ note: `wiki/${cat}/${wf}`, missing: missingCore });
            const deprecated = isDeprecatedFrontmatter(fm);
            if (deprecated) {
              stats.wikiDeprecated += 1;
              deprecatedWikiStems.add(stem);
              const target = supersededTarget(fm.superseded_by);
              if (target) {
                const supStem = basename(target.split("|")[0]).replace(/\.md$/, "");
                supersededChecks.push({ from: `${cat}/${wf}`, raw: target, stem: supStem });
              }
            } else if (repoRoots.length > 0) {
              const missingPaths = [];
              for (const rel of extractRepoFileRefs(body)) {
                const topDir = rel.split("/")[0];
                const anchored = repoRoots.some(r => existsSync(join(r, topDir)) && statSync(join(r, topDir)).isDirectory());
                if (anchored && !repoRoots.some(r => existsSync(join(r, rel)))) {
                  missingPaths.push(rel);
                }
              }
              if (missingPaths.length > 0) {
                stats.codeDrift.push({ note: `${cat}/${wf}`, missingPaths });
                stats.warnings.push(
                  `Code drift: ${cat}/${wf} references repo file(s) that no longer exist: ${missingPaths.join(", ")} — if they were renamed or moved, update the paths; mark the note deprecated: true only if the approach itself is obsolete.`
                );
              }
            }
            const sourcesMatch = txt.match(/^sources:\s*(?:\[([^\]]*)\]|\r?\n((?:\s*-\s*[^\r\n]+\r?\n)*))/m);
            if (sourcesMatch) {
              const matchedText = sourcesMatch[0];
              const links = Array.from(matchedText.matchAll(/\[\[([^\]]+)\]\]/g), m => m[1]);
              for (const lk of links) {
                const cleanLk = basename(lk.split("|")[0]);
                const cleanStem = cleanLk.replace(/\.md$/, "");
                if (!rawFiles.has(cleanLk) && !rawFiles.has(cleanStem)) {
                  stats.missingSources.push(`${cat}/${wf} -> raw missing: [[${lk}]]`);
                }
              }
            }
          }
        }
      }

      for (const check of supersededChecks) {
        if (!wikiFiles.has(check.stem)) {
          stats.brokenLinks.push(`${check.from} -> superseded_by missing: [[${check.raw}]]`);
        } else if (deprecatedWikiStems.has(check.stem)) {
          stats.warnings.push(`${check.from} -> superseded_by points to another deprecated note: [[${check.raw}]]`);
        }
      }

      const validateIndexLinks = (label, txt) => {
        const links = Array.from(txt.matchAll(/\[\[([^\]]+)\]\]/g), m => m[1]);
        for (const lk of links) {
          const cleanStem = basename(lk.split("|")[0]).replace(/\.md$/, "");
          if (["rules", "log", "index", "AGENTS", "raw-index"].includes(cleanStem)) continue;
          if (!wikiFiles.has(cleanStem) && !rawFiles.has(cleanStem) && !checkpointFiles.has(cleanStem) && !subIndexStems.has(cleanStem)) {
            stats.brokenLinks.push(`${label} -> nonexistent note: [[${lk}]]`);
          }
        }
      };

      if (stats.indexMd) {
        const txt = readFileSync(join(pDir, "index.md"), "utf8");
        stats.indexLines = txt.split(/\r?\n/).length;
        validateIndexLinks("index.md", txt);
      }
      for (const sub of subIndexPaths) {
        validateIndexLinks(sub.label, readFileSync(sub.path, "utf8"));
      }
      const rawIndexPath = join(pRaw, "raw-index.md");
      if (existsSync(rawIndexPath)) {
        validateIndexLinks("raw/raw-index.md", readFileSync(rawIndexPath, "utf8"));
      }

      const coreWarning = coreFieldWarning(`Project [${pName}]`, stats.missingCoreFields);
      if (coreWarning) stats.warnings.push(coreWarning);

      if ((stats.wikiTotal >= SCALE_WIKI_THRESHOLD || stats.indexLines >= SCALE_INDEX_LINES_THRESHOLD) && !stats.hasSubIndexes) {
        stats.warnings.push(
          `Project [${pName}] has ${stats.wikiTotal} wiki notes and ${stats.indexLines} index.md lines; consider splitting raw/raw-index.md and wiki/index-<module>.md.`
        );
      }

      result.projects[pName] = stats;
    }
  }

  // 4. Security Scan
  function scanDir(dir) {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir)) {
      if (item.startsWith(".") || item === "node_modules") continue;
      const fullPath = join(dir, item);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          scanDir(fullPath);
        } else if (item.endsWith(".md")) {
          const text = readFileSync(fullPath, "utf8");
          for (const pattern of SECRET_PATTERNS) {
            if (pattern.regex.test(text)) {
              result.security.secretHits.push({
                file: fullPath.slice(vaultPath.length + 1),
                type: pattern.name
              });
              break;
            }
          }
        }
      } catch {}
    }
  }
  scanDir(vaultPath);

  if (result.security.secretHits.length > 0) {
    result.issues.push(`Found ${result.security.secretHits.length} potential secret(s) in Vault notes`);
  }

  if (result.issues.length > 0) result.ok = false;
  return result;
}

export function formatReport(result) {
  const lines = [];
  lines.push("=== Obsidian Memory Vault Health Check ===");
  lines.push(`Vault: ${result.vaultPath}\n`);

  lines.push("--- 1. 基础设施与系统文件 (00-System) ---");
  lines.push(`  Root AGENTS.md: ${result.system.agents ? "[OK]" : "[FAIL]"}`);
  lines.push(`  Root Home.md: ${result.system.home ? "[OK]" : "[WARN]"}`);
  lines.push(`  projects.yaml: ${result.system.projectsYaml ? `[OK] (${result.system.registeredProjects.length} projects registered)` : "[FAIL]"}`);
  lines.push(`  Templates (14 expected): ${result.system.missingTemplates.length === 0 ? "[OK] (all 14 present)" : `[FAIL] Missing: ${result.system.missingTemplates.join(", ")}`}`);
  for (const w of result.system.warnings) {
    lines.push(`  [WARN] ${w}`);
  }

  lines.push("\n--- 2. 全局作用域 (10-Global) ---");
  if (result.global.exists) {
    lines.push(`  Core files: preferences=${result.global.preferences ? "✓" : "✗"}, index=${result.global.index ? "✓" : "✗"}, log=${result.global.log ? "✓" : "✗"}`);
    lines.push(`  Inbox: ${result.global.inboxPending} pending, ${result.global.inboxIngested} ingested${result.global.inboxArchived ? ` (${result.global.inboxArchived} archived)` : ""}`);
    lines.push(`  Raw: ${result.global.rawCount} records`);
  } else {
    lines.push("  10-Global not initialized.");
  }

  lines.push("\n--- 3. 项目作用域 (20-Projects) ---");
  const pNames = Object.keys(result.projects);
  if (pNames.length === 0) {
    lines.push("  No project directories found.");
  } else {
    for (const pName of pNames) {
      const p = result.projects[pName];
      lines.push(`\n  📁 Project: ${pName}`);
      lines.push(`     Schema: ${p.schemaState} | AGENTS=${p.agentsMd ? "✓" : "✗"} rules=${p.rulesMd ? "✓" : "✗"} index=${p.indexMd ? `✓ (${p.indexLines} lines)` : "✗"} log=${p.logMd ? "✓" : "✗"}`);
      lines.push(`     Inbox: ${p.inboxPending} pending, ${p.inboxIngested} ingested${p.inboxArchived ? ` (${p.inboxArchived} archived)` : ""} | Raw: ${p.rawCount}`);
      lines.push(`     Wiki: ${p.wikiTotal} total (${p.wikiDecisions} decisions, ${p.wikiPitfalls} pitfalls, ${p.wikiKnowledge} knowledge${p.wikiDeprecated ? `, ${p.wikiDeprecated} deprecated` : ""})`);
      if (p.warnings?.length > 0) {
        for (const w of p.warnings) lines.push(`     [WARN] ${w}`);
      }
      if (p.missingSources.length > 0) {
        for (const ms of p.missingSources) lines.push(`     ⚠️ Missing source: ${ms}`);
      }
      if (p.brokenLinks.length > 0) {
        for (const bl of p.brokenLinks) lines.push(`     ⚠️ Broken index link: ${bl}`);
      }
    }
  }

  lines.push("\n--- 4. 安全与凭据审计 ---");
  if (result.security.secretHits.length === 0) {
    lines.push("  [OK] No plaintext API keys, private keys, or tokens detected.");
  } else {
    for (const hit of result.security.secretHits) {
      lines.push(`  ⚠️ [SECURITY ALERT] ${hit.file}: ${hit.type}`);
    }
  }

  lines.push("\n==========================================");
  lines.push(`Summary: ${result.ok ? "🟢 HEALTHY (No blocking issues)" : "🔴 ISSUES FOUND"}`);
  if (result.issues.length > 0) {
    lines.push("Action required:");
    for (const iss of result.issues) lines.push(`  - ${iss}`);
  }
  return lines.join("\n");
}

function parseArgs(args) {
  const options = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--vault") {
      options.vaultPath = args[++i];
    } else if (a === "--json") {
      options.json = true;
    } else if (a === "--help" || a === "-h") {
      options.help = true;
    }
  }
  return options;
}

export async function runCli(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    console.log(`Usage: node scripts/check-vault.mjs [--vault <path>] [--json]

Inspects the Obsidian Memory Vault for health, template completeness, link integrity, and plaintext secrets.
If --vault is omitted, it auto-detects from OBSIDIAN_MEMORY_VAULT or active GEMINI.md/AGENTS.md.`);
    return;
  }

  const vaultPath = opts.vaultPath ?? autoDetectVault();
  if (!vaultPath) {
    console.error("Error: Could not detect Obsidian Vault. Please specify --vault <absolute-path> or set OBSIDIAN_MEMORY_VAULT.");
    process.exitCode = 1;
    return;
  }

  const result = checkVault(vaultPath);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isEntrypoint) {
  runCli();
}
