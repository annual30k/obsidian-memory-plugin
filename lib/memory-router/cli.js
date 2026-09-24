#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMemoryJudgeConfig } from "../config.js";
import { MemoryRouter } from "./router.js";
import { getDefaultCachePath } from "./cache.js";
import { containsSensitiveContent } from "./fast-path.js";
import { buildLayaActionNotice } from "../prompt.js";

export function normalizePathForComparison(p) {
  if (!p) return "";
  let normalized = String(p).replace(/\\/g, "/");
  if (/^\/[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const fileUrlPath = fileURLToPath(importMetaUrl);
    let scriptPath;
    let entryPath;
    try {
      scriptPath = fs.realpathSync(fileUrlPath);
    } catch {
      scriptPath = fileUrlPath;
    }
    try {
      entryPath = fs.realpathSync(path.resolve(argv1));
    } catch {
      entryPath = argv1;
    }

    const normScript = normalizePathForComparison(scriptPath);
    const normEntry = normalizePathForComparison(entryPath);

    const isWindows = process.platform === "win32" || /^[a-zA-Z]:\//.test(normScript) || /^[a-zA-Z]:\//.test(normEntry);
    if (isWindows) {
      return normScript.toLowerCase() === normEntry.toLowerCase();
    }
    return normScript === normEntry;
  } catch {
    return false;
  }
}

export function parseArgs(args) {
  const options = { text: null, candidate: null, existing: null, task: "recall", projectId: null, config: {}, cachePath: null, stdinMode: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stdin") {
      options.stdinMode = true;
    } else if (arg === "--capture") {
      options.task = "capture";
    } else if (arg === "--relation") {
      options.task = "relation";
    } else if (arg === "--text" && i + 1 < args.length) {
      options.text = args[++i];
    } else if (arg === "--project-id" && i + 1 < args.length) {
      options.projectId = args[++i];
    } else if (arg === "--mode" && i + 1 < args.length) {
      options.config.mode = args[++i];
    } else if (arg === "--endpoint" && i + 1 < args.length) {
      options.config.endpoint = args[++i];
    } else if (arg === "--service-file" && i + 1 < args.length) {
      options.config.serviceFile = args[++i];
    } else if (arg === "--cache-path" && i + 1 < args.length) {
      options.cachePath = args[++i];
    }
  }
  return options;
}

export async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function runCli(args = process.argv.slice(2), { stdin = null, stdout = process.stdout } = {}) {
  const parsedArgs = parseArgs(args);

  // Take an independent snapshot of explicit CLI flags before reading stdin!
  const cliText = parsedArgs.text;
  const cliProjectId = parsedArgs.projectId;
  const cliCandidate = parsedArgs.candidate;
  const cliExisting = parsedArgs.existing;
  const cliConfigSnapshot = { ...parsedArgs.config };

  let stdinText = null;
  let stdinProjectId = null;
  let stdinCandidate = null;
  let stdinExisting = null;
  let stdinConfig = null;
  let stdinTurn = null;

  // ONLY read from stdin when --stdin is explicitly passed
  if (parsedArgs.stdinMode) {
    const streamToRead = stdin || process.stdin;
    try {
      const input = await readStream(streamToRead);
      if (input) {
        try {
          const parsedJson = JSON.parse(input);
          if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
            if (typeof parsedJson.text === "string") {
              stdinText = parsedJson.text;
            }
            if (typeof parsedJson.projectId === "string") {
              stdinProjectId = parsedJson.projectId;
            }
            if (typeof parsedJson.candidate === "string") stdinCandidate = parsedJson.candidate;
            if (typeof parsedJson.existing === "string") stdinExisting = parsedJson.existing;
            if (parsedJson.config && typeof parsedJson.config === "object" && !Array.isArray(parsedJson.config)) {
              stdinConfig = parsedJson.config;
            }
            // Host turn context (Hermes): enables Vault hints, session continuity and the decision log.
            if (parsedJson.turn && typeof parsedJson.turn === "object" && !Array.isArray(parsedJson.turn)) {
              const t = parsedJson.turn;
              const str = (v, max = 4096) => (typeof v === "string" && v && v.length <= max && !/[\u0000-\u001f]/u.test(v) ? v : null);
              stdinTurn = {
                host: str(t.host, 32) ?? "cli",
                sessionKey: str(t.sessionKey, 256),
                vaultPath: str(t.vaultPath) && path.isAbsolute(t.vaultPath) ? t.vaultPath : null,
                cwd: str(t.cwd)
              };
            }
          } else {
            stdinText = input;
          }
        } catch {
          stdinText = input;
        }
      }
    } catch {}
  }

  // Enforce precedence: Explicit CLI flags > stdin JSON
  const text = cliText !== null ? cliText : (stdinText !== null ? stdinText : "");
  const projectId = cliProjectId !== null ? cliProjectId : stdinProjectId;
  const candidate = cliCandidate ?? stdinCandidate;
  const existing = cliExisting ?? stdinExisting;
  const config = { ...(stdinConfig || {}), ...cliConfigSnapshot };
  // Same override the Codex / Antigravity hooks honour, so every host can be pointed at another
  // (or a deliberately missing) service file.
  if (config.serviceFile === undefined && typeof process.env.OBSIDIAN_MEMORY_SERVICE_FILE === "string" &&
      process.env.OBSIDIAN_MEMORY_SERVICE_FILE.trim()) {
    config.serviceFile = process.env.OBSIDIAN_MEMORY_SERVICE_FILE.trim();
  }

  let router;
  try {
    const parsedConfig = parseMemoryJudgeConfig(config);
    router = new MemoryRouter(parsedConfig, {
      cachePath: parsedArgs.cachePath || getDefaultCachePath(),
      useCache: true
    });

    if (parsedArgs.task !== "recall") {
      if (parsedArgs.task === "capture" && router.config.proactiveCapture === false) {
        stdout.write(JSON.stringify({ task: "capture", recommended: false, score: null, confidence: null, category: null, scope: null, reason: "capture_disabled" }) + "\n");
        return 0;
      }
      if (parsedArgs.task === "capture" && containsSensitiveContent(text)) {
        stdout.write(JSON.stringify({ task: "capture", recommended: false, score: null, confidence: null, category: null, scope: null, reason: "sensitive_content" }) + "\n");
        return 0;
      }
      if (parsedArgs.task === "relation" && (containsSensitiveContent(candidate || "") || containsSensitiveContent(existing || ""))) {
        stdout.write(JSON.stringify({ task: "relation", relation: "unrelated", confidence: null, reason: "sensitive_content" }) + "\n");
        return 0;
      }
      if (router.config.mode === "off" || !router.client || (parsedArgs.task === "capture" && !text.trim()) || (parsedArgs.task === "relation" && (!candidate?.trim() || !existing?.trim()))) {
        stdout.write(JSON.stringify(parsedArgs.task === "relation"
          ? { task: "relation", relation: "unrelated", confidence: null, reason: router.config.mode === "off" ? "mode_off" : "invalid_or_unavailable" }
          : { task: "capture", recommended: false, score: null, confidence: null, category: null, scope: null, reason: router.config.mode === "off" ? "mode_off" : "invalid_or_unavailable" }) + "\n");
        return 0;
      }
      const timeout = router.config.timeout;
      await router.client.healthCheck({ timeout: router.config.healthTimeout });
      const judged = parsedArgs.task === "capture"
        ? await router.client.judgeCapture({ text, timeout })
        : await router.client.judgeRelation({ candidate, existing, timeout });
      stdout.write(JSON.stringify(parsedArgs.task === "capture"
        ? { task: "capture", recommended: judged.captureScore >= router.config.captureThreshold && judged.confidence >= 0.6, score: judged.captureScore, confidence: judged.confidence, category: judged.category, scope: judged.scope }
        : { task: "relation", relation: judged.relation, confidence: judged.confidence }) + "\n");
      return 0;
    }

    const result = await router.evaluateRecall(text, projectId ? { project_id: projectId } : null, stdinTurn);

    const guidanceAppend = buildLayaActionNotice(result);

    const output = {
      recallRecommended: result.recallRecommended,
      captureRecommended: result.captureRecommended ?? false,
      captureCategory: result.captureCategory ?? null,
      score: result.score ?? null,
      scope: result.scope ?? null,
      categories: result.categories ?? null,
      blocked: result.blocked ?? false,
      memoryAction: result.memoryAction ?? "default",
      relatedNotes: result.relatedNotes ?? [],
      reason: result.reason,
      trace: result.trace ?? null,
      guidanceAppend
    };

    stdout.write(JSON.stringify(output) + "\n");
    return 0;
  } catch (err) {
    // In fallback mode, output safe JSON without failing with exit code 1
    const output = parsedArgs.task === "relation" ? {
      task: "relation",
      relation: "unrelated",
      confidence: null,
      reason: "laya_unavailable"
    } : parsedArgs.task === "capture" ? {
      task: "capture",
      recommended: false,
      score: null,
      confidence: null,
      category: null,
      scope: null,
      reason: "laya_unavailable"
    } : {
      recallRecommended: false,
      captureRecommended: false,
      captureCategory: null,
      score: null,
      scope: null,
      blocked: false,
      reason: "cli_error",
      error: "evaluation_failed",
      trace: {
        route: "fallback",
        decision: "none",
        reason: "cli_error",
        hookExecuted: false,
        layaAttempted: false
      },
      guidanceAppend: null
    };
    stdout.write(JSON.stringify(output) + "\n");
    return 0;
  } finally {
    router?.dispose();
  }
}

if (isMain(import.meta.url)) {
  runCli().catch(() => process.exit(0));
}
