#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMemoryJudgeConfig } from "../config.js";
import { MemoryRouter } from "./router.js";
import { getDefaultCachePath } from "./cache.js";

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
  const options = { text: null, projectId: null, config: {}, cachePath: null, stdinMode: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stdin") {
      options.stdinMode = true;
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
  const cliConfigSnapshot = { ...parsedArgs.config };

  let stdinText = null;
  let stdinProjectId = null;
  let stdinConfig = null;

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
            if (parsedJson.config && typeof parsedJson.config === "object" && !Array.isArray(parsedJson.config)) {
              stdinConfig = parsedJson.config;
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
  const config = { ...(stdinConfig || {}), ...cliConfigSnapshot };

  let router;
  try {
    const parsedConfig = parseMemoryJudgeConfig(config);
    router = new MemoryRouter(parsedConfig, {
      cachePath: parsedArgs.cachePath || getDefaultCachePath(),
      useCache: true
    });

    const result = await router.evaluateRecall(text, projectId ? { project_id: projectId } : null);

    let guidanceAppend = null;
    if (result.recallRecommended) {
      const scope = result.scope === "global" ? "global" : "project";
      guidanceAppend = `[Laya Memory Judge: recall recommended (scope: ${scope}). Search Vault before proceeding.]`;
    }

    const output = {
      recallRecommended: result.recallRecommended,
      score: result.score ?? null,
      scope: result.scope ?? null,
      reason: result.reason,
      guidanceAppend
    };

    stdout.write(JSON.stringify(output) + "\n");
    return 0;
  } catch (err) {
    // In fallback mode, output safe JSON without failing with exit code 1
    const output = {
      recallRecommended: false,
      score: null,
      scope: null,
      reason: "cli_error",
      error: "evaluation_failed",
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
