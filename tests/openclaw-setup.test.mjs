import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { buildEntry, runSetup } from "../scripts/setup-openclaw.mjs";

function host({ entry, allow, agents = [{ id: "main" }, { id: "health-manager" }] } = {}) {
  const state = { entry, allow, writes: [] };
  const run = (_bin, args) => {
    if (args[0] === "agents") return { status: 0, stdout: JSON.stringify(agents) };
    if (args[0] === "config" && args[1] === "get") {
      const value = args[2].endsWith("obsidian-memory-plugin") ? state.entry : state.allow;
      return value === undefined
        ? { status: 1, stdout: JSON.stringify({ error: { message: "Config path is valid but unset" } }) }
        : { status: 0, stdout: JSON.stringify(value) };
    }
    if (args[0] === "config" && args[1] === "set") {
      const key = args[2].endsWith("obsidian-memory-plugin") ? "entry" : "allow";
      const expected = args.indexOf("--expect-current-json");
      if (!args.includes("--dry-run")) {
        if (expected >= 0) assert.deepEqual(state[key], JSON.parse(args[expected + 1]));
        else assert.equal(state[key], undefined);
        state[key] = JSON.parse(args[3]);
        state.writes.push(key);
      }
      return { status: 0, stdout: "ok" };
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  return { state, run };
}

test("OpenClaw setup merges a new agent without erasing existing agents, hooks, or allowlist", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-openclaw-"));
  try {
    const vault = join(root, "vault");
    mkdirSync(vault);
    const { state, run } = host({
      entry: {
        enabled: false,
        hooks: { custom: true },
        config: { agentId: "health-manager", vaultPath: "/old-vault", projectId: "Health" }
      },
      allow: ["another-plugin"]
    });
    await runSetup(["--vault", vault, "--agent", "main", "--yes"], {
      input: new PassThrough(), output: new PassThrough(), run
    });
    assert.deepEqual(state.writes, ["entry", "allow"]);
    assert.equal(state.entry.enabled, true);
    assert.equal(state.entry.hooks.custom, true);
    assert.equal(state.entry.hooks.allowPromptInjection, true);
    assert.equal(state.entry.config.agentConfigs.main.vaultPath, vault);
    assert.equal(state.entry.config.agentConfigs["health-manager"].projectId, "Health");
    assert.deepEqual(state.allow, ["another-plugin", "obsidian-memory-plugin"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw setup dry-run validates but changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-openclaw-"));
  try {
    const vault = join(root, "vault");
    mkdirSync(vault);
    const { state, run } = host();
    await runSetup(["--vault", vault, "--agent", "main", "--dry-run"], {
      input: new PassThrough(), output: new PassThrough(), run
    });
    assert.deepEqual(state.writes, []);
    assert.equal(state.entry, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw setup refuses unknown agents and noninteractive inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-openclaw-"));
  try {
    const vault = join(root, "vault");
    mkdirSync(vault);
    const { state, run } = host();
    await assert.rejects(() => runSetup(["--vault", vault, "--yes"], {
      input: new PassThrough(), output: new PassThrough(), run
    }), /requires explicit/);
    await assert.rejects(() => runSetup(["--vault", vault, "--agent", "missing", "--yes"], {
      input: new PassThrough(), output: new PassThrough(), run
    }), /does not exist/);
    await assert.rejects(() => runSetup(["--vault", vault, "--agent", " ", "--yes"], {
      input: new PassThrough(), output: new PassThrough(), run
    }), /Invalid OpenClaw agent ID/);
    assert.deepEqual(state.writes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw setup keeps existing multi-agent settings when updating one Vault", () => {
  const entry = buildEntry({
    config: {
      memoryJudge: { mode: "manual", endpoint: "http://127.0.0.1:18791" },
      agentConfigs: {
        main: { vaultPath: "/old", projectId: "Personal" },
        "health-manager": { vaultPath: "/health", projectId: "Health" }
      }
    }
  }, "main", "/new");
  assert.equal(entry.config.agentConfigs.main.vaultPath, "/new");
  assert.equal(entry.config.agentConfigs.main.projectId, "Personal");
  assert.equal(entry.config.agentConfigs["health-manager"].vaultPath, "/health");
  assert.deepEqual(entry.config.memoryJudge, { mode: "manual", endpoint: "http://127.0.0.1:18791" });
});
