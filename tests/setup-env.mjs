// Loaded with `node --import` for every test process: keep tests away from the user's real
// decision log (~/.laya/decisions.jsonl) and cache directory (session state, Vault index).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OBSIDIAN_MEMORY_DECISION_LOG = "off";
// Never start a background session digest from a test process (tests call runDigest directly).
process.env.OBSIDIAN_MEMORY_DIGEST = "off";
if (!process.env.OBSIDIAN_MEMORY_TEST_CACHE) {
  process.env.OBSIDIAN_MEMORY_TEST_CACHE = mkdtempSync(join(tmpdir(), "om-test-cache-"));
}
process.env.XDG_CACHE_HOME = process.env.OBSIDIAN_MEMORY_TEST_CACHE;
// All plugin files (state, caches, capture queue, digest log) go to a private test folder, never ~/.laya.
process.env.OBSIDIAN_MEMORY_LAYA_DIR = process.env.OBSIDIAN_MEMORY_TEST_CACHE;
// Hook processes would otherwise find the developer's real Vault through ~/.codex/AGENTS.md or
// ~/.gemini/GEMINI.md and add Vault hints to turns the tests expect to stay unchanged.
process.env.OBSIDIAN_MEMORY_VAULT = "/nonexistent-obsidian-memory-test-vault";
process.env.CODEX_HOME = process.env.OBSIDIAN_MEMORY_TEST_CACHE;
// Keep tests offline from a Laya service the developer may have running (~/.laya/service.json);
// tests that need a service start their own and pass its file explicitly.
if (!process.env.OBSIDIAN_MEMORY_TEST_KEEP_SERVICE) {
  process.env.OBSIDIAN_MEMORY_SERVICE_FILE = join(process.env.OBSIDIAN_MEMORY_TEST_CACHE, "no-laya-service.json");
}
