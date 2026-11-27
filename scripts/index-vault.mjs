#!/usr/bin/env node
/**
 * Fill the Vault's note-vector cache in one go (`laya index`).
 *
 * Each turn's hook embeds at most one batch of 32 texts, so a large or newly migrated Vault takes hundreds
 * of turns to be fully covered, and semantic hints only see the covered part meanwhile. This runs the
 * same indexing outside a turn until nothing is pending (or the time budget runs out), with progress.
 * Read-only for the Vault; writes only the index and embedding caches under ~/.laya/cache.
 *
 *   laya index [--vault <path>] [--max-minutes 30]
 */
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { memoryJudgeFromEnv } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";
import {
  loadVaultIndex, loadEmbeddingCache, ensureVaultEmbeddings, pendingEmbeddings, resolveVaultPath,
  defaultIndexCachePath, defaultEmbeddingCachePath
} from "../lib/memory-router/vault-index.js";

const BATCH = 32;

export function parseArgs(argv = []) {
  const opts = { vaultPath: null, maxMinutes: 30, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) opts.vaultPath = argv[++i];
    else if (a === "--max-minutes" && argv[i + 1]) opts.maxMinutes = Number(argv[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  if (!Number.isFinite(opts.maxMinutes) || opts.maxMinutes <= 0) opts.maxMinutes = 30;
  return opts;
}

const textCount = (notes) => notes.reduce((n, note) => n + (Array.isArray(note.embedChunks) ? note.embedChunks.length : 1), 0);

/**
 * Embed every pending note through `embedPassages(texts) -> { model, vectors }`.
 * Returns { notes, embedded, pending, texts, seconds, stopped }.
 */
export async function indexVault({
  vaultPath, embedPassages, model, indexCachePath = defaultIndexCachePath(), embeddingCachePath = defaultEmbeddingCachePath(),
  maxMs = 30 * 60 * 1000, now = Date.now, onProgress = () => {}
}) {
  const start = now();
  const index = loadVaultIndex(vaultPath, { cachePath: indexCachePath });
  if (!index) return { notes: 0, embedded: 0, pending: 0, texts: 0, seconds: 0, stopped: "no_vault" };
  const cache = loadEmbeddingCache(embeddingCachePath, { vaultPath, model });
  const total = textCount(pendingEmbeddings(index, cache));
  let embedded = 0;
  let done = 0;
  let stopped = null;
  while (pendingEmbeddings(index, cache).length > 0) {
    if (now() - start > maxMs) { stopped = "time_budget"; break; }
    const before = textCount(pendingEmbeddings(index, cache));
    const r = await ensureVaultEmbeddings(index, cache, async (texts) => {
      const out = await embedPassages(texts);
      if (!out || out.model !== model) throw new Error("the retriever model changed while indexing");
      return out.vectors;
    }, { cachePath: embeddingCachePath, maxNotes: BATCH });
    if (!r.embedded) { stopped = "no_progress"; break; }
    embedded += r.embedded;
    done += before - textCount(pendingEmbeddings(index, cache));
    onProgress({ done, total, notesLeft: r.pending, seconds: (now() - start) / 1000 });
  }
  return { notes: index.n, embedded, pending: pendingEmbeddings(index, cache).length, texts: done, seconds: (now() - start) / 1000, stopped };
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out.write("Usage: laya index [--vault <path>] [--max-minutes 30]\nEmbeds every Vault note that has no vector yet, so semantic hints cover the whole Vault now.\n");
    return 0;
  }
  const vaultPath = opts.vaultPath ? path.resolve(opts.vaultPath) : resolveVaultPath();
  if (!vaultPath) { err.write("Error: Could not detect the Obsidian Vault. Pass --vault <absolute-path>.\n"); return 1; }
  const router = createMemoryRouter(memoryJudgeFromEnv(process.env), { useCache: true });
  try {
    const probe = await router.embedTexts(["index"], "query", { timeout: 15000 });
    if (!probe?.model) { err.write("Error: the Laya service is not answering embeddings (try `laya status` / `laya start`).\n"); return 1; }
    let last = 0;
    const result = await indexVault({
      vaultPath,
      model: probe.model,
      embedPassages: (texts) => router.embedTexts(texts, "passage", { timeout: 120000 }),
      maxMs: opts.maxMinutes * 60 * 1000,
      onProgress: ({ done, total, seconds }) => {
        if (seconds - last < 2 && done < total) return;
        last = seconds;
        out.write(`  ${done}/${total} texts embedded (${seconds.toFixed(0)} s)\n`);
      }
    });
    out.write(`Vault index: ${result.notes} notes; embedded ${result.embedded} notes (${result.texts} texts) in ${result.seconds.toFixed(1)} s; ${result.pending} still pending.\n`);
    if (result.stopped === "time_budget") out.write("Stopped at the time budget; run `laya index` again to continue.\n");
    if (result.stopped === "no_progress") { err.write("Stopped: the retriever returned no usable vectors.\n"); return 1; }
    return 0;
  } finally {
    router.dispose?.();
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) main().then((code) => process.exit(code));
