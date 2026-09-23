import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findPython } from "../scripts/python.mjs";
import {
  detectBackend,
  maskToken,
  findUv,
  readPidFile,
  startCommand,
  statusCommand,
  stopCommand,
  uninstallCommand,
  parseArgs,
  LAYA_HF_CACHE_DIRS
} from "../scripts/laya-service.mjs";
import { validateHealthResponse, validateRecallResponse } from "../lib/memory-router/schemas.js";
import { readTrustedServiceFile } from "../lib/memory-router/security.js";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { LayaClient } from "../lib/memory-router/client.js";
import { runCli } from "../lib/memory-router/cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVICE_PY = path.resolve(__dirname, "..", "lib", "laya-service", "service.py");
const python = findPython();

test("detectBackend platform and arch parameter injection", () => {
  assert.equal(detectBackend("mock"), "mock");
  assert.equal(detectBackend("mlx"), "mlx");
  assert.equal(detectBackend("pytorch"), "pytorch");

  assert.equal(detectBackend(null, "darwin", "arm64"), "mlx");
  assert.equal(detectBackend(null, "darwin", "x64"), "pytorch");
  assert.equal(detectBackend(null, "win32", "x64"), "pytorch");
  assert.equal(detectBackend(null, "linux", "x64"), "pytorch");
  assert.equal(detectBackend(null, "linux", "arm64"), "pytorch");

  assert.equal(detectBackend("mock", "darwin", "arm64"), "mock");
  assert.equal(detectBackend("pytorch", "darwin", "arm64"), "pytorch");
});

test("maskToken masks token safely", () => {
  assert.equal(maskToken(""), "none");
  assert.equal(maskToken(null), "none");
  assert.equal(maskToken(123), "none");
  assert.equal(maskToken("short"), "***");
  assert.equal(maskToken("12345678"), "***");
  assert.equal(maskToken("123456789"), "1234...6789");
  assert.equal(maskToken("1234567890abcdef"), "1234...cdef");
});

test("findUv supports dependency injection for environment and platform independence", () => {
  // 1. Host lookup (if available)
  const uv = findUv();
  if (uv) {
    assert.ok(fs.existsSync(uv), "uv executable must exist when detected");
  }

  // 2. Mock injection success
  const mockExecSuccess = () => ({ status: 0, stdout: "uv 0.6.0\n" });
  const found = findUv(null, {
    homedir: "/fake/home",
    platform: "darwin",
    execFn: mockExecSuccess
  });
  assert.ok(found);
  assert.ok(found.includes("uv"));

  // 3. Mock injection failure (no uv anywhere)
  const mockExecFail = () => ({ status: 1 });
  const notFound = findUv(null, {
    homedir: "/fake/home",
    platform: "darwin",
    execFn: mockExecFail,
    env: {}
  });
  assert.equal(notFound, null);

  // 4. Custom uv path accepted directly
  const tmpUv = path.join(os.tmpdir(), "mock-uv-" + Date.now());
  fs.writeFileSync(tmpUv, "");
  try {
    assert.equal(findUv(tmpUv), tmpUv);
  } finally {
    fs.unlinkSync(tmpUv);
  }
});

test("service.py rejects non-loopback host bindings with exit code 2", () => {
  const badHosts = ["0.0.0.0", "192.168.1.10", "example.com"];
  for (const badHost of badHosts) {
    const res = spawnSync(python.command, [
      ...python.args,
      SERVICE_PY,
      "--host", badHost,
      "--port", "0"
    ], { encoding: "utf8", windowsHide: true });

    assert.equal(res.status, 2, `Host ${badHost} must be rejected with exit code 2`);
    assert.ok(res.stderr.includes("not a permitted loopback address"), `Stderr should explain loopback requirement: ${res.stderr}`);
  }
});

test("UDS startup refuses symlinks and ordinary files without replacing their targets", () => {
  if (process.platform === "win32") return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-uds-path-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const target = path.join(tmpDir, "keep.txt");
  const socketPath = path.join(tmpDir, "service.sock");
  try {
    fs.writeFileSync(target, "preserve me");
    fs.writeFileSync(socketPath, "not a socket");
    const fileRes = spawnSync(python.command, [...python.args, SERVICE_PY, "--backend", "mock", "--transport", "uds", "--service-file", serviceFile, "--socket-file", socketPath], { encoding: "utf8", windowsHide: true });
    assert.equal(fileRes.status, 2);
    assert.equal(fs.readFileSync(socketPath, "utf8"), "not a socket");

    fs.unlinkSync(socketPath);
    fs.symlinkSync(target, socketPath);
    const linkRes = spawnSync(python.command, [...python.args, SERVICE_PY, "--backend", "mock", "--transport", "uds", "--service-file", serviceFile, "--socket-file", socketPath], { encoding: "utf8", windowsHide: true });
    assert.equal(linkRes.status, 2);
    assert.equal(fs.readFileSync(target, "utf8"), "preserve me");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("service.py strictly rejects symlinks for token-file, service-file, and pid-file without modifying targets (P0-3)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-symlink-test-"));
  try {
    // 1. token-file symlink check
    const realTokenFile = path.join(tmpDir, "real_token.txt");
    fs.writeFileSync(realTokenFile, "super-secret-target-token-content\n");
    const symlinkToken = path.join(tmpDir, "symlink_token");
    try {
      fs.symlinkSync(realTokenFile, symlinkToken);
    } catch {
      // If OS doesn't allow symlinks (unprivileged Windows), skip
      return;
    }

    const tokenRes = spawnSync(python.command, [
      ...python.args,
      SERVICE_PY,
      "--token-file", symlinkToken,
      "--service-file", path.join(tmpDir, "token-test-service.json"),
      "--backend", "mock",
      "--port", "0"
    ], { encoding: "utf8", windowsHide: true });

    assert.equal(tokenRes.status, 2, "Must exit with code 2 for symlink token-file");
    assert.ok(tokenRes.stderr.includes("is a symlink"), `Stderr should report symlink error: ${tokenRes.stderr}`);
    assert.ok(fs.existsSync(realTokenFile), "real_token.txt must NOT be deleted!");
    assert.equal(fs.readFileSync(realTokenFile, "utf8"), "super-secret-target-token-content\n", "Target file must not be modified");

    // 2. service-file symlink check
    const realServiceFile = path.join(tmpDir, "real_service.json");
    fs.writeFileSync(realServiceFile, JSON.stringify({ canary: "keep_me" }));
    const symlinkService = path.join(tmpDir, "symlink_service");
    fs.symlinkSync(realServiceFile, symlinkService);

    const srvRes = spawnSync(python.command, [
      ...python.args,
      SERVICE_PY,
      "--service-file", symlinkService,
      "--backend", "mock",
      "--port", "0"
    ], { encoding: "utf8", windowsHide: true });

    assert.equal(srvRes.status, 2, "Must exit with code 2 for symlink service-file");
    assert.ok(srvRes.stderr.includes("is a symlink"));
    assert.ok(fs.existsSync(realServiceFile), "real_service.json must NOT be deleted!");
    assert.equal(JSON.parse(fs.readFileSync(realServiceFile, "utf8")).canary, "keep_me");

    // 3. pid-file symlink check
    const realPidFile = path.join(tmpDir, "real_pid.txt");
    fs.writeFileSync(realPidFile, "99999\n");
    const symlinkPid = path.join(tmpDir, "symlink_pid");
    fs.symlinkSync(realPidFile, symlinkPid);

    const pidRes = spawnSync(python.command, [
      ...python.args,
      SERVICE_PY,
      "--pid-file", symlinkPid,
      "--service-file", path.join(tmpDir, "pid-test-service.json"),
      "--backend", "mock",
      "--port", "0"
    ], { encoding: "utf8", windowsHide: true });

    assert.equal(pidRes.status, 2, "Must exit with code 2 for symlink pid-file");
    assert.ok(pidRes.stderr.includes("is a symlink"));
    assert.ok(fs.existsSync(realPidFile), "real_pid.txt must NOT be deleted!");
    assert.equal(fs.readFileSync(realPidFile, "utf8").trim(), "99999");

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("daemon.pid is written atomically with 0600 and only unlinked when identity matches (P1-4)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-pid-atomic-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pidFile = path.join(tmpDir, "daemon.pid");
  const token = "pid-atomic-token";

  const pyProc = spawn(python.command, [
    ...python.args,
    SERVICE_PY,
    "--backend", "mock",
    "--service-file", serviceFile,
    "--pid-file", pidFile,
    "--token", token,
    "--port", "0"
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  try {
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      if (fs.existsSync(pidFile) && fs.existsSync(serviceFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(pidFile), "daemon.pid must exist");

    // Check POSIX permissions
    if (process.platform !== "win32") {
      const stat = fs.statSync(pidFile);
      assert.equal(stat.mode & 0o077, 0, "daemon.pid must have 0600 permissions");
    }

    const pidData = readPidFile(pidFile);
    assert.equal(pidData.pid, pyProc.pid);
    assert.ok(pidData.instance_id, "daemon.pid must contain instance_id");

    // Simulate service B taking over daemon.pid
    const foreignPidData = { pid: 88888, instance_id: "foreign-instance-id" };
    fs.writeFileSync(pidFile, JSON.stringify(foreignPidData));

    // Terminate service A
    pyProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));

    // daemon.pid must NOT be deleted because it belongs to B!
    assert.ok(fs.existsSync(pidFile), "daemon.pid must NOT be deleted if replaced by another instance");
    const remainingPid = readPidFile(pidFile);
    assert.equal(remainingPid.instance_id, "foreign-instance-id");

  } finally {
    try { pyProc.kill("SIGKILL"); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("service-file OS lock prevents concurrent daemons and releases after exit", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-singleton-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pyArgs = [...python.args, SERVICE_PY, "--backend", "mock", "--transport", "http", "--service-file", serviceFile];
  const first = spawn(python.command, pyArgs, { windowsHide: true, stdio: "ignore" });
  let third;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(serviceFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(serviceFile), "first daemon should register");
    const original = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    assert.equal(original.pid, first.pid);

    const second = spawnSync(python.command, pyArgs, { windowsHide: true, encoding: "utf8", timeout: 5000 });
    assert.equal(second.status, 3, second.stderr);
    assert.match(second.stderr, /already owned by another process/);
    assert.deepEqual(JSON.parse(fs.readFileSync(serviceFile, "utf8")), original);

    first.kill("SIGTERM");
    const exitDeadline = Date.now() + 10000;
    while (first.exitCode === null && first.signalCode === null && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(first.exitCode !== null || first.signalCode !== null, "first daemon should exit");

    third = spawn(python.command, pyArgs, { windowsHide: true, stdio: "ignore" });
    const nextDeadline = Date.now() + 10000;
    while ((!fs.existsSync(serviceFile) || JSON.parse(fs.readFileSync(serviceFile, "utf8")).pid !== third.pid) && Date.now() < nextDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(JSON.parse(fs.readFileSync(serviceFile, "utf8")).pid, third.pid, "lock should be reusable after exit");
  } finally {
    if (third) third.kill("SIGTERM");
    first.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while ((first.exitCode === null && first.signalCode === null || third && third.exitCode === null && third.signalCode === null) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Python service with mock backend starts on ephemeral port, enforces auth, and respects contracts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-srv-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pidFile = path.join(tmpDir, "daemon.pid");
  const token = "test-secret-token-1234567890";

  const pyProc = spawn(python.command, [
    ...python.args,
    SERVICE_PY,
    "--backend", "mock",
    "--service-file", serviceFile,
    "--pid-file", pidFile,
    "--token", token,
    "--port", "0"
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutData = "";
  let stderrData = "";
  pyProc.stdout.on("data", (d) => { stdoutData += d.toString(); });
  pyProc.stderr.on("data", (d) => { stderrData += d.toString(); });

  try {
    // 1. Wait for service.json to be created
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      if (fs.existsSync(serviceFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(serviceFile), `service.json must exist within 10s. stderr: ${stderrData}`);

    // Verify POSIX permissions on service.json
    if (process.platform !== "win32") {
      const stat = fs.statSync(serviceFile);
      assert.equal((stat.mode & 0o077), 0, "service.json must have 0600 permissions");
    }

    // Read and validate service file via security module
    const trusted = readTrustedServiceFile(serviceFile, {
      homedir: () => tmpDir,
      allowCustomWindowsPath: true
    });
    assert.ok(trusted, "service.json must be accepted by readTrustedServiceFile");
    assert.equal(trusted.token, token);
    const endpoint = trusted.endpoint;

    // 2. GET /health with missing / bad token -> 401
    const unauthHealth = await fetch(`${endpoint}/health`);
    assert.equal(unauthHealth.status, 401, "Missing token must return 401");

    const badAuthHealth = await fetch(`${endpoint}/health`, {
      headers: { Authorization: "Bearer wrong-token" }
    });
    assert.equal(badAuthHealth.status, 401, "Wrong token must return 401");

    // 3. GET /health with valid token -> 200, valid schema
    const authHealth = await fetch(`${endpoint}/health`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(authHealth.status, 200);
    const healthJson = await authHealth.json();
    const validatedHealth = validateHealthResponse(healthJson);
    assert.equal(validatedHealth.service, "laya-memory-judge");
    assert.equal(validatedHealth.status, "ok");
    assert.equal(validatedHealth.modelStatus, "ready");
    assert.ok(validatedHealth.capabilities.includes("recall"));

    // 4. POST /judge/recall with valid token -> 200, valid schema
    const recallResp = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        text: "请帮我回忆之前的踩坑记录",
        project_context: { project_id: "test-proj" }
      })
    });
    assert.equal(recallResp.status, 200);
    const recallJson = await recallResp.json();
    const validatedRecall = validateRecallResponse(recallJson);
    assert.ok(validatedRecall.requiresMemory >= 0.7, "Memory question should have high requires_memory");
    assert.ok(validatedRecall.confidence > 0.5);
    assert.equal(validatedRecall.bestScope, "project");

    const captureResp = await fetch(`${endpoint}/judge/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "Verified pitfall: restart the local model after its idle unload before relying on the next inference." })
    });
    assert.equal(captureResp.status, 200);
    const captureJson = await captureResp.json();
    assert.equal(typeof captureJson.capture_score, "number");
    assert.ok(["pitfall", "decision", "knowledge"].includes(captureJson.category));

    const relationResp = await fetch(`${endpoint}/judge/relation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ candidate: "test-relation:supersession", existing: "Previous policy excerpt" })
    });
    assert.equal(relationResp.status, 200);
    const relationJson = await relationResp.json();
    assert.equal(relationJson.relation, "supersession");
    assert.ok(relationJson.confidence >= 0 && relationJson.confidence <= 1);

    // 5. POST /judge/recall with oversized body -> 413
    const oversizedBody = JSON.stringify({ text: "a".repeat(70000) });
    const overResp = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: oversizedBody
    });
    assert.equal(overResp.status, 413, "Body exceeding 64KB must return 413");

    // 6. Strict Request Validations (P1.3)
    // 6a. Content-Length <= 0 -> 400
    const zeroLenResp = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "0",
        Authorization: `Bearer ${token}`
      }
    });
    assert.equal(zeroLenResp.status, 400);

    // 6b. Empty / whitespace text -> 400
    const emptyTextResp = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ text: "   " })
    });
    assert.equal(emptyTextResp.status, 400);

    // 6c. Text > 2048 chars -> 400
    const longTextResp = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ text: "a".repeat(2049) })
    });
    assert.equal(longTextResp.status, 400);

    // 6d. Invalid project_id format / length -> 400
    const badProjResp1 = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ text: "valid text", project_context: { project_id: "../bad/traversal" } })
    });
    assert.equal(badProjResp1.status, 400);

    const badProjResp2 = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ text: "valid text", project_context: { project_id: "a".repeat(257) } })
    });
    assert.equal(badProjResp2.status, 400);

    const validProjResp = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ text: "valid text", project_context: { project_id: "valid_project-123" } })
    });
    assert.equal(validProjResp.status, 200);

    // 7. Authenticated POST /shutdown (P0-2 strict validation)
    // 7a. Unauthorized shutdown -> 401
    const unauthShut = await fetch(`${endpoint}/shutdown`, { method: "POST" });
    assert.equal(unauthShut.status, 401);

    // 7b. Missing body or invalid JSON -> 400
    const noBodyShut = await fetch(`${endpoint}/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(noBodyShut.status, 400);

    const badJsonShut = await fetch(`${endpoint}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "not-json"
    });
    assert.equal(badJsonShut.status, 400);

    // 7c. Missing or wrong PID -> 400
    const missingPidShut = await fetch(`${endpoint}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(missingPidShut.status, 400);

    const mismatchShut = await fetch(`${endpoint}/shutdown`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ pid: 99999999, instance_id: trusted.instance_id })
    });
    assert.equal(mismatchShut.status, 400);

    // Missing instance_id -> 400
    const missingInstShut = await fetch(`${endpoint}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pid: pyProc.pid })
    });
    assert.equal(missingInstShut.status, 400);

    // Mismatched instance_id -> 400
    const mismatchInstShut = await fetch(`${endpoint}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pid: pyProc.pid, instance_id: "wrong-instance-id" })
    });
    assert.equal(mismatchInstShut.status, 400);

    // Server must still be healthy and running after invalid shutdown attempts
    const stillHealthy = await fetch(`${endpoint}/health`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(stillHealthy.status, 200);

    // 7d. Authorized shutdown with correct PID and instance_id -> 200 with service identity
    const okShut = await fetch(`${endpoint}/shutdown`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ pid: pyProc.pid, instance_id: trusted.instance_id })
    });
    assert.equal(okShut.status, 200);
    const shutJson = await okShut.json();
    assert.equal(shutJson.service, "laya-memory-judge");
    assert.equal(shutJson.status, "shutting_down");
    assert.equal(shutJson.pid, pyProc.pid);
    assert.equal(shutJson.instance_id, trusted.instance_id);

    // Process should terminate cleanly within 3s
    const shutWait = Date.now();
    while (Date.now() - shutWait < 3000) {
      if (pyProc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(pyProc.exitCode !== null, "Process must terminate after /shutdown");
    assert.equal(fs.existsSync(serviceFile), false, "service.json must be cleaned up on shutdown");

  } finally {
    try { pyProc.kill("SIGKILL"); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MLX backend loads on first inference, unloads after idle, and loads again on demand", () => {
  const script = String.raw`
import runpy, sys, time, types
loads = []
class FakeAgent:
    def predict(self, state, questions):
        return {"answers": {
            "requires_memory": {"probabilities": {"yes": 0.1}, "confidence": 0.9},
            "scope": {"probabilities": {"project": 0.8, "global": 0.1, "unknown": 0.1}},
            "category": {"probabilities": {"pitfall": 0.1, "decision": 0.8, "knowledge": 0.1}, "confidence": 0.9}
        }}
def fake_load(name):
    loads.append(name)
    return FakeAgent()
sys.modules["laya_mlx"] = types.SimpleNamespace(load=fake_load)
ns = runpy.run_path(sys.argv[1])
backend = ns["MlxBackend"]("test-model", idle_unload_seconds=1)
backend.release_backend_cache = lambda: None
assert backend.status == "unloaded" and not loads
backend.predict("first")
assert backend.status == "ready" and len(loads) == 1
backend.last_used_at = time.monotonic() - 2
assert backend.unload_if_idle(1)
assert backend.status == "unloaded" and backend.agent is None
backend.predict("second")
assert backend.status == "ready" and len(loads) == 2
print("lazy-load / idle-unload / reload lifecycle passed")
`;
  const result = spawnSync(python.command, [...python.args, "-c", script, SERVICE_PY], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /lazy-load \/ idle-unload \/ reload lifecycle passed/);
});

test("running service reports unloaded after idle and reloads on the next inference request", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-idle-unload-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const token = "idle-unload-test-token-123456";
  const pyProc = spawn(python.command, [
    ...python.args,
    SERVICE_PY,
    "--backend", "mock",
    "--idle-unload-seconds", "1",
    "--service-file", serviceFile,
    "--token", token,
    "--port", "0"
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  let stderrData = "";
  pyProc.stderr.on("data", (d) => { stderrData += d.toString(); });
  const authHeaders = { Authorization: `Bearer ${token}` };
  const getHealth = async (endpoint) => {
    const response = await fetch(`${endpoint}/health`, { headers: authHeaders });
    assert.equal(response.status, 200, stderrData);
    return response.json();
  };
  const waitForStatus = async (endpoint, expected, timeoutMs = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const health = await getHealth(endpoint);
      if (health.model_status === expected) return health;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Timed out waiting for model_status=${expected}. ${stderrData}`);
  };

  try {
    const started = Date.now();
    while (!fs.existsSync(serviceFile) && Date.now() - started < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(serviceFile), `service.json was not created. ${stderrData}`);
    const service = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    const endpoint = service.endpoint;

    await waitForStatus(endpoint, "unloaded");
    const response = await fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Can the model reload after becoming idle?" })
    });
    const recall = await response.json();
    assert.equal(response.status, 200, JSON.stringify(recall));
    assert.equal(recall.requires_memory, 0.12);
    assert.equal((await waitForStatus(endpoint, "ready")).model_status, "ready");
    await waitForStatus(endpoint, "unloaded");
  } finally {
    try { pyProc.kill("SIGTERM"); } catch {}
    await new Promise((resolve) => {
      if (pyProc.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 1500);
      pyProc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (pyProc.exitCode === null) {
      try { pyProc.kill("SIGKILL"); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Secure token delivery via --token-file deletes temporary file on startup", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-token-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const tokenFile = path.join(tmpDir, ".token_secret");
  const secretToken = "super-secret-token-from-file-42";

  fs.writeFileSync(tokenFile, secretToken + "\n", { encoding: "utf8", mode: 0o600 });

  const pyProc = spawn(python.command, [
    ...python.args,
    SERVICE_PY,
    "--backend", "mock",
    "--service-file", serviceFile,
    "--token-file", tokenFile,
    "--port", "0"
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      if (fs.existsSync(serviceFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(serviceFile));

    // tokenFile must have been deleted by Python service immediately
    assert.equal(fs.existsSync(tokenFile), false, "token-file must be deleted upon service startup");

    const data = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    assert.equal(data.token, secretToken, "Token in service.json must match delivered token");

    // Authenticate with the token
    const res = await fetch(`${data.endpoint}/health`, {
      headers: { Authorization: `Bearer ${secretToken}` }
    });
    assert.equal(res.status, 200);

  } finally {
    pyProc.kill("SIGKILL");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("service detaches output pipes before post-start model logging", async () => {
  const script = [
    "import sys, time",
    `sys.path.insert(0, ${JSON.stringify(path.dirname(SERVICE_PY))})`,
    "from service import redirect_stdio_to_devnull",
    "print('startup-ready', flush=True)",
    "redirect_stdio_to_devnull()",
    "time.sleep(0.05)",
    "print('late-stdout', flush=True)",
    "print('late-stderr', file=sys.stderr, flush=True)"
  ].join("\n");
  const child = spawn(python.command, [...python.args, "-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  });
  let output = "";
  let detached = false;
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Python output-detach test timed out"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!detached && output.includes("startup-ready")) {
        detached = true;
        // Mirror laya-service.mjs closing its startup readers after health.
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.equal(detached, true, `startup output was not received: ${output}`);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.doesNotMatch(output, /late-(?:stdout|stderr)/);
});

test("Node management CLI start, status, and stop workflow with mock backend", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-cli-test-"));
  const serviceFile = path.join(tmpDir, ".laya", "service.json");

  try {
    // 1. Initial status -> Stopped
    let stdoutBuffer = "";
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { stdoutBuffer += chunk; return true; };

    try {
      await statusCommand({ home: tmpDir });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.ok(stdoutBuffer.includes("STOPPED"), "Initial status must be STOPPED");

    // 2. Start mock service
    await startCommand({
      home: tmpDir,
      backend: "mock",
      timeoutMs: 15000
    });

    assert.ok(fs.existsSync(serviceFile), "service.json must exist after start");
    const serviceData = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    if (process.platform !== "win32") {
      assert.equal(serviceData.transport, "uds");
      assert.equal(fs.statSync(serviceData.socket_path).mode & 0o777, 0o600);
      const trusted = readTrustedServiceFile(serviceFile);
      assert.equal(trusted.endpoint, `uds:${serviceData.socket_path}`);
      assert.equal(trusted.token, serviceData.token);
    } else {
      assert.equal(serviceData.transport, "http");
      assert.ok(serviceData.endpoint.startsWith("http://127.0.0.1:"));
    }
    const client = new LayaClient(serviceData.endpoint, { token: serviceData.token });
    const capture = await client.judgeCapture({ text: "Verified pitfall: the service reloads the model after idle unload." });
    assert.ok(capture.captureScore > 0.75);
    assert.equal(capture.category, "pitfall");
    const relation = await client.judgeRelation({ candidate: "test-relation:supersession", existing: "old decision" });
    assert.equal(relation.relation, "supersession");
    for (const [args, input] of [
      [["--capture", "--stdin"], { text: "Verified pitfall: the model reloads after idle unload.", config: { mode: "auto", serviceFile } }],
      [["--relation", "--stdin"], { candidate: "test-relation:duplicate", existing: "previous fact", config: { mode: "auto", serviceFile } }]
    ]) {
      let output = "";
      const code = await runCli(args, { stdin: Readable.from([JSON.stringify(input)]), stdout: { write: (chunk) => { output += chunk; } } });
      assert.equal(code, 0);
      assert.equal(JSON.parse(output).task, args[0] === "--capture" ? "capture" : "relation");
    }

    // 3. Status -> Running
    stdoutBuffer = "";
    process.stdout.write = (chunk) => { stdoutBuffer += chunk; return true; };
    try {
      await statusCommand({ home: tmpDir });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.ok(stdoutBuffer.includes("RUNNING"), "Status after start must be RUNNING");
    assert.ok(stdoutBuffer.includes("mock"), "Status must report mock backend");
    assert.equal(fs.existsSync(path.join(tmpDir, ".laya", ".autostart-disabled")), false);

    // 4. Stop service gracefully
    await stopCommand({ home: tmpDir });

    assert.equal(fs.existsSync(serviceFile), false, "service.json must be removed after stop");
    assert.equal(fs.existsSync(path.join(tmpDir, ".laya", ".autostart-disabled")), true, "explicit stop must suppress background recovery");

    // A deliberate manual start re-enables crash recovery.
    await startCommand({ home: tmpDir, backend: "mock", timeoutMs: 15000 });
    assert.equal(fs.existsSync(path.join(tmpDir, ".laya", ".autostart-disabled")), false, "manual start must clear the stop marker");
    await stopCommand({ home: tmpDir });

    // 5. Final status -> Stopped
    stdoutBuffer = "";
    process.stdout.write = (chunk) => { stdoutBuffer += chunk; return true; };
    try {
      await statusCommand({ home: tmpDir });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.ok(stdoutBuffer.includes("STOPPED"), "Status after stop must be STOPPED");

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("automatic recovery start honors an explicit stop marker without starting the service", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-recovery-suppressed-"));
  const layaDir = path.join(tmpDir, ".laya");
  const serviceFile = path.join(layaDir, "service.json");
  fs.mkdirSync(layaDir, { recursive: true });
  fs.writeFileSync(path.join(layaDir, ".autostart-disabled"), "stopped\n");
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    await startCommand({ home: tmpDir, backend: "mock", recovery: true });
    assert.equal(fs.existsSync(serviceFile), false);
    assert.equal(fs.existsSync(path.join(layaDir, ".autostart-disabled")), true);
    assert.match(output, /explicitly stopped/);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("stopCommand throws error and refuses fake success if process remains alive after /shutdown (P0-2)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-stubborn-srv-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pidFile = path.join(tmpDir, "daemon.pid");

  // Create a fake HTTP server that accepts /shutdown with 200 but DOES NOT exit
  const stubServer = http.createServer((req, res) => {
    if (req.url === "/shutdown") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "laya-memory-judge",
        status: "shutting_down",
        pid: process.pid,
        instance_id: "stub-instance-123"
      }));
      // Process intentionally stays alive!
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  const port = stubServer.address().port;

  fs.writeFileSync(serviceFile, JSON.stringify({
    service: "laya-memory-judge",
    api_version: "1",
    endpoint: `http://127.0.0.1:${port}`,
    token: "valid-tok",
    pid: process.pid,
    instance_id: "stub-instance-123"
  }));
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, instance_id: "stub-instance-123" }));

  try {
    // stopCommand must fail with error indicating process did not exit within timeout
    await assert.rejects(
      async () => {
        await stopCommand({ serviceFile, pidFile });
      },
      (err) => {
        assert.ok(err.message.includes("still running"), `Expected timeout error, got: ${err.message}`);
        return true;
      }
    );
  } finally {
    stubServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("uninstallCommand aborts when service shutdown fails, preserving running process, venv, and metadata (P0-1)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-uninst-protect-"));
  const layaDir = path.join(tmpDir, ".laya");
  const venvDir = path.join(layaDir, "venv");
  const serviceFile = path.join(layaDir, "service.json");
  const pidFile = path.join(layaDir, "daemon.pid");

  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(path.join(venvDir, "important_venv.txt"), "preserve me");

  // Point service.json to current Node test process and an unresponsive port
  fs.writeFileSync(serviceFile, JSON.stringify({
    service: "laya-memory-judge",
    api_version: "1",
    endpoint: "http://127.0.0.1:19991",
    token: "uninst-tok",
    pid: process.pid,
    instance_id: "uninst-inst"
  }));
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, instance_id: "uninst-inst" }));

  try {
    await assert.rejects(
      async () => {
        await uninstallCommand({ home: tmpDir });
      },
      (err) => {
        assert.ok(err.message.includes("Failed to send /shutdown") || err.message.includes("Cannot uninstall") || err.message.includes("ECONNREFUSED"));
        return true;
      }
    );

    // CRITICAL: current test runner process is still alive!
    assert.equal(process.exitCode, undefined);
    // CRITICAL: venv and service files were NOT deleted!
    assert.ok(fs.existsSync(venvDir), "venv directory must NOT be deleted on failed shutdown");
    assert.ok(fs.existsSync(path.join(venvDir, "important_venv.txt")));
    assert.ok(fs.existsSync(serviceFile), "service.json must NOT be deleted on failed shutdown");

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Python service on shutdown only removes service.json if it matches its own endpoint and token", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-cleanup-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pidFile = path.join(tmpDir, "daemon.pid");
  const tokenA = "token-service-A";

  const pyProc = spawn(python.command, [
    ...python.args,
    SERVICE_PY,
    "--backend", "mock",
    "--service-file", serviceFile,
    "--pid-file", pidFile,
    "--token", tokenA,
    "--port", "0"
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    // Wait for service.json
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      if (fs.existsSync(serviceFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(serviceFile));

    // Simulate service B taking over service.json before service A exits
    const serviceBContent = {
      service: "laya-memory-judge",
      api_version: "1",
      endpoint: "http://127.0.0.1:19999",
      token: "token-service-B",
      pid: 99999,
      instance_id: "foreign-b"
    };
    fs.writeFileSync(serviceFile, JSON.stringify(serviceBContent), "utf8");

    // Terminate service A
    pyProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));

    // Assert that service.json was NOT deleted because it belongs to B!
    assert.ok(fs.existsSync(serviceFile), "service.json must NOT be deleted if overwritten by new identity");
    const remaining = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    assert.equal(remaining.token, "token-service-B");

  } finally {
    try { pyProc.kill("SIGKILL"); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("uninstallCommand stops dead service, cleans venv and runtime files", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "laya-uninst-test-"));
  try {
    const layaDir = path.join(tmpHome, ".laya");
    const venvDir = path.join(layaDir, "venv");
    const serviceFile = path.join(layaDir, "service.json");
    const pidFile = path.join(layaDir, "daemon.pid");

    fs.mkdirSync(venvDir, { recursive: true });
    fs.writeFileSync(path.join(venvDir, "pyvenv.cfg"), "home = /fake");
    fs.writeFileSync(serviceFile, JSON.stringify({ pid: 12345, token: "tok", endpoint: "http://127.0.0.1:9" }));
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 12345 }));

    let stdoutData = "";
    const origWrite = process.stdout.write;
    process.stdout.write = (c) => { stdoutData += c; return true; };
    try {
      await uninstallCommand({ home: tmpHome });
    } finally {
      process.stdout.write = origWrite;
    }

    assert.equal(fs.existsSync(venvDir), false, "venv directory must be deleted");
    assert.equal(fs.existsSync(serviceFile), false, "service.json must be deleted");
    assert.equal(fs.existsSync(pidFile), false, "daemon.pid must be deleted");
    assert.equal(fs.existsSync(layaDir), false, ".laya directory must be deleted when empty");
    assert.ok(stdoutData.includes("successfully uninstalled"));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("uninstallCommand preserves custom user files in .laya directory and does not remove directory if not empty", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "laya-custom-keep-"));
  try {
    const layaDir = path.join(tmpHome, ".laya");
    const venvDir = path.join(layaDir, "venv");
    const customUserFile = path.join(layaDir, "my-custom-note.txt");

    fs.mkdirSync(venvDir, { recursive: true });
    fs.writeFileSync(customUserFile, "important user note", "utf8");

    let stdoutData = "";
    const origWrite = process.stdout.write;
    process.stdout.write = (c) => { stdoutData += c; return true; };
    try {
      await uninstallCommand({ home: tmpHome });
    } finally {
      process.stdout.write = origWrite;
    }

    assert.equal(fs.existsSync(venvDir), false, "venv directory must be deleted");
    assert.equal(fs.existsSync(customUserFile), true, "custom user file must be preserved");
    assert.equal(fs.existsSync(layaDir), true, ".laya directory must be preserved because it is not empty");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("uninstallCommand with --purge-cache only purges Laya model directories, preserving others (P1-6)", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "laya-hf-purge-"));
  const origHomedir = os.homedir;
  try {
    const mockHomedir = tmpHome;
    const hubDir = path.join(mockHomedir, ".cache", "huggingface", "hub");
    fs.mkdirSync(hubDir, { recursive: true });

    const layaMlxDir = path.join(hubDir, LAYA_HF_CACHE_DIRS[0]);
    const layaTorchDir = path.join(hubDir, LAYA_HF_CACHE_DIRS[1]);
    const otherModelDir = path.join(hubDir, "models--meta-llama--Llama-3-8B");

    fs.mkdirSync(layaMlxDir);
    fs.mkdirSync(layaTorchDir);
    fs.mkdirSync(otherModelDir);

    os.homedir = () => mockHomedir;

    await uninstallCommand({ home: tmpHome, purgeCache: true });

    assert.equal(fs.existsSync(layaMlxDir), false, "Laya MLX cache must be purged");
    assert.equal(fs.existsSync(layaTorchDir), false, "Laya PyTorch cache must be purged");
    assert.equal(fs.existsSync(otherModelDir), true, "Other Hugging Face models must be PRESERVED!");

  } finally {
    os.homedir = origHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("inference semaphore queues briefly, then answers 503 quickly under a pile-up (P1-5)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-conc-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pidFile = path.join(tmpDir, "daemon.pid");
  const token = "conc-test-secret-token";

  const pyProc = spawn(python.command, [
    ...python.args,
    SERVICE_PY,
    "--backend", "mock",
    "--service-file", serviceFile,
    "--pid-file", pidFile,
    "--token", token,
    "--port", "0"
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LAYA_MOCK_DELAY: "0.1" } });

  try {
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      if (fs.existsSync(serviceFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const data = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    const endpoint = data.endpoint;

    // Send 10 concurrent requests at the exact same time
    const makeReq = () => fetch(`${endpoint}/judge/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "回忆之前的踩坑记录" })
    });

    const startReqTime = Date.now();
    const responses = await Promise.all([
      makeReq(), makeReq(), makeReq(), makeReq(), makeReq(),
      makeReq(), makeReq(), makeReq(), makeReq(), makeReq()
    ]);
    const durationMs = Date.now() - startReqTime;

    const statuses = responses.map((r) => r.status);
    const okCount = statuses.filter((s) => s === 200).length;
    const busyCount = statuses.filter((s) => s === 503).length;

    assert.ok(okCount >= 1, "At least one request should succeed");
    assert.equal(statuses.every((s) => s === 200 || s === 503), true, "All responses must be 200 or 503");
    // Bounded wait (1 s cap per request): the pile-up still resolves quickly
    assert.ok(durationMs < 2500, `Requests must finish rapidly, took ${durationMs}ms`);
    assert.ok(okCount >= 5, `Overlapping requests should mostly queue and succeed, got ${okCount}/10`);

  } finally {
    try { pyProc.kill("SIGKILL"); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MemoryRouter auto mode end-to-end integration with mock service", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-router-e2e-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pidFile = path.join(tmpDir, "daemon.pid");
  const token = "router-e2e-token-secret-1234";

  const pyProc = spawn(python.command, [
    ...python.args,
    SERVICE_PY,
    "--backend", "mock",
    "--service-file", serviceFile,
    "--pid-file", pidFile,
    "--token", token,
    "--port", "0"
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      if (fs.existsSync(serviceFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(serviceFile));

    const router = new MemoryRouter({
      mode: "auto",
      serviceFile: serviceFile
    });

    const routerResult = await router.evaluateRecall("如何配置数据库连接池？之前遇到过什么问题？", { project_id: "test-proj" });
    assert.equal(routerResult.recallRecommended, true);
    assert.equal(routerResult.scope, "project");
    router.dispose();

  } finally {
    pyProc.kill("SIGKILL");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("safeCompareTokens and matchesServiceIdentity / matchesPidIdentity enforce strict matching", async () => {
  const { safeCompareTokens, matchesServiceIdentity, matchesPidIdentity } = await import("../scripts/laya-service.mjs");

  assert.equal(safeCompareTokens("abc", "abc"), true);
  assert.equal(safeCompareTokens("abc", "abd"), false);
  assert.equal(safeCompareTokens("abc", "abcd"), false);
  assert.equal(safeCompareTokens("", ""), true);
  assert.equal(safeCompareTokens(null, "abc"), false);

  const expectedService = {
    pid: 1234,
    instance_id: "inst-1",
    endpoint: "http://127.0.0.1:8000",
    token: "tok-123"
  };

  assert.equal(matchesServiceIdentity({ ...expectedService }, expectedService), true);
  assert.equal(matchesServiceIdentity({ ...expectedService, pid: 1235 }, expectedService), false);
  assert.equal(matchesServiceIdentity({ ...expectedService, instance_id: "inst-2" }, expectedService), false);
  assert.equal(matchesServiceIdentity({ ...expectedService, endpoint: "http://127.0.0.1:8001" }, expectedService), false);
  assert.equal(matchesServiceIdentity({ ...expectedService, token: "wrong" }, expectedService), false);

  const expectedPid = { pid: 1234, instance_id: "inst-1" };
  assert.equal(matchesPidIdentity({ pid: 1234, instance_id: "inst-1" }, expectedPid), true);
  assert.equal(matchesPidIdentity({ pid: 1235, instance_id: "inst-1" }, expectedPid), false);
  assert.equal(matchesPidIdentity({ pid: 1234, instance_id: "inst-2" }, expectedPid), false);
});

test("stopCommand throws when instance_id mismatches in /shutdown response", async () => {
  const { stopCommand } = await import("../scripts/laya-service.mjs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-stop-inst-mismatch-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const pidFile = path.join(tmpDir, "daemon.pid");

  const stubServer = http.createServer((req, res) => {
    if (req.url === "/shutdown") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "laya-memory-judge",
        status: "shutting_down",
        pid: process.pid,
        instance_id: "evil-foreign-instance"
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  const port = stubServer.address().port;

  fs.writeFileSync(serviceFile, JSON.stringify({
    service: "laya-memory-judge",
    api_version: "1",
    endpoint: `http://127.0.0.1:${port}`,
    token: "valid-tok",
    pid: process.pid,
    instance_id: "expected-instance"
  }));
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, instance_id: "expected-instance" }));

  try {
    await assert.rejects(
      async () => {
        await stopCommand({ serviceFile, pidFile });
      },
      (err) => {
        assert.ok(err.message.includes("Instance ID mismatch"), `Expected instance ID mismatch, got: ${err.message}`);
        return true;
      }
    );
  } finally {
    stubServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("service.py remove_service_file_if_matched and remove_pid_file_if_matched enforce all identity fields", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-py-cleanup-"));
  try {
    const pyScript = `
import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from service import remove_service_file_if_matched, remove_pid_file_if_matched

tmp = Path(sys.argv[2])
svc = tmp / "service.json"
pidf = tmp / "daemon.pid"

def reset_svc(data):
    svc.write_text(json.dumps(data), encoding="utf-8")

def reset_pid(content):
    pidf.write_text(content, encoding="utf-8")

base_svc = {"endpoint": "http://127.0.0.1:8000", "token": "tok123", "instance_id": "instA", "pid": 100}

# 1. Matching -> deleted
reset_svc(base_svc)
remove_service_file_if_matched(svc, "http://127.0.0.1:8000", "tok123", "instA", 100)
assert not svc.exists(), "Matching service file should be deleted"

# 2. PID mismatch -> kept
reset_svc(base_svc)
remove_service_file_if_matched(svc, "http://127.0.0.1:8000", "tok123", "instA", 999)
assert svc.exists(), "PID mismatch should keep file"

# 3. instance_id mismatch -> kept
reset_svc(base_svc)
remove_service_file_if_matched(svc, "http://127.0.0.1:8000", "tok123", "instB", 100)
assert svc.exists(), "instance_id mismatch should keep file"

# 4. token mismatch -> kept
reset_svc(base_svc)
remove_service_file_if_matched(svc, "http://127.0.0.1:8000", "badtok", "instA", 100)
assert svc.exists(), "token mismatch should keep file"

# 5. endpoint mismatch -> kept
reset_svc(base_svc)
remove_service_file_if_matched(svc, "http://127.0.0.1:9000", "tok123", "instA", 100)
assert svc.exists(), "endpoint mismatch should keep file"

# 6. PID file matching -> deleted
reset_pid(json.dumps({"pid": 100, "instance_id": "instA"}))
remove_pid_file_if_matched(pidf, 100, "instA")
assert not pidf.exists(), "Matching pid file should be deleted"

# 7. PID file instance_id mismatch -> kept
reset_pid(json.dumps({"pid": 100, "instance_id": "instB"}))
remove_pid_file_if_matched(pidf, 100, "instA")
assert pidf.exists(), "instance_id mismatch in pid file should keep file"

# 8. PID file raw number without instance_id -> kept (insecure fallback removed)
reset_pid("100")
remove_pid_file_if_matched(pidf, 100, "instA")
assert pidf.exists(), "bare pid without instance_id should keep file"

print("ALL_CLEANUP_TESTS_PASSED")
`;
    const serviceDir = path.dirname(SERVICE_PY);
    const res = spawnSync(python.command, [...python.args, "-c", pyScript, serviceDir, tmpDir], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(res.status, 0, `Python test failed: ${res.stderr}`);
    assert.ok(res.stdout.includes("ALL_CLEANUP_TESTS_PASSED"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("linkGlobalCli and unlinkGlobalCli safely link and unlink global binary", async () => {
  const { linkGlobalCli, unlinkGlobalCli } = await import("../scripts/laya-service.mjs");
  const origHomedir = os.homedir;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "laya-global-cli-test-"));

  try {
    os.homedir = () => tmpHome;

    const ok = linkGlobalCli();
    assert.equal(ok, true);

    const localBin = path.join(tmpHome, ".local", "bin");
    if (process.platform !== "win32") {
      assert.ok(fs.existsSync(path.join(localBin, "laya")));
      assert.ok(fs.existsSync(path.join(localBin, "laya-service")));
      assert.ok(fs.lstatSync(path.join(localBin, "laya")).isSymbolicLink());
    } else {
      assert.ok(fs.existsSync(path.join(localBin, "laya.cmd")));
      assert.ok(fs.existsSync(path.join(localBin, "laya-service.cmd")));
    }

    unlinkGlobalCli();
    if (process.platform !== "win32") {
      assert.equal(fs.existsSync(path.join(localBin, "laya")), false);
      assert.equal(fs.existsSync(path.join(localBin, "laya-service")), false);
    } else {
      assert.equal(fs.existsSync(path.join(localBin, "laya.cmd")), false);
      assert.equal(fs.existsSync(path.join(localBin, "laya-service.cmd")), false);
    }

  } finally {
    os.homedir = origHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("laya-service parseArgs parses all CLI arguments including --port", () => {
  const res = parseArgs(["start", "--port", "52752", "--idle-unload-seconds", "1800", "--backend", "mock", "--model", "custom/model", "--venv", "/custom/venv", "--home", "/custom/home", "--recovery", "--force", "--purge-cache"]);
  assert.equal(res.command, "start");
  assert.equal(res.options.port, 52752);
  assert.equal(res.options.idleUnloadSeconds, 1800);
  assert.equal(res.options.backend, "mock");
  assert.equal(res.options.model, "custom/model");
  assert.equal(res.options.venv, "/custom/venv");
  assert.equal(res.options.home, "/custom/home");
  assert.equal(res.options.recovery, true);
  assert.equal(res.options.force, true);
  assert.equal(res.options.purgeCache, true);
});

test("MLX backend never passes a null/empty project_id to the model as the string \"None\"", () => {
  const script = String.raw`
import runpy, sys, types
states = []
class FakeAgent:
    def predict(self, state, questions):
        states.append(dict(state))
        return {"answers": {"requires_memory": {"probabilities": {"yes": 0.5}, "confidence": 0.5}}}
sys.modules["laya_mlx"] = types.SimpleNamespace(load=lambda name: FakeAgent())
ns = runpy.run_path(sys.argv[1])
backend = ns["MlxBackend"]("test-model")
for ctx in (None, {}, {"project_id": None}, {"project_id": ""}, {"project_id": "   "}):
    backend.predict("t", ctx)
backend.predict("t", {"project_id": "demo-app"})
need_calls = [s for s in states if "task" not in s]
detail_calls = [s for s in states if "task" in s]
# The memory-need question is always asked on the bare text only.
assert all(set(s) == {"text"} for s in need_calls) and len(need_calls) == 6, states
assert all("project_id" not in s for s in detail_calls[:5]), states
assert detail_calls[5]["project_id"] == "demo-app", states
print("project_id sanitization passed")
`;
  const result = spawnSync(python.command, [...python.args, "-c", script, SERVICE_PY], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /project_id sanitization passed/);
});

test("--preload warms the model in the background right after the service starts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-preload-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const token = "preload-test-token-1234567890";
  const pyProc = spawn(python.command, [
    ...python.args, SERVICE_PY, "--backend", "mock", "--preload", "--idle-unload-seconds", "0",
    "--service-file", serviceFile, "--token", token, "--port", "0"
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LAYA_MOCK_LOAD_DELAY: "0.5" } });
  let stderrData = "";
  pyProc.stderr.on("data", (d) => { stderrData += d.toString(); });
  try {
    const started = Date.now();
    while (!fs.existsSync(serviceFile) && Date.now() - started < 10000) await new Promise((r) => setTimeout(r, 50));
    const { endpoint } = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    const seen = new Set();
    let ready = false;
    while (Date.now() - started < 10000) {
      const health = await (await fetch(`${endpoint}/health`, { headers: { Authorization: `Bearer ${token}` } })).json();
      seen.add(health.model_status);
      if (health.model_status === "ready") { ready = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, `model never became ready without a request; saw ${[...seen]} ${stderrData}`);
    // No inference request was sent: readiness came from the preload thread.
    const t = Date.now();
    const res = await fetch(`${endpoint}/judge/recall`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello there friend" }) });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t < 400, "first request after preload must not pay the load delay");
  } finally {
    try { pyProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => { if (pyProc.exitCode !== null) return r(); const timer = setTimeout(r, 1500); pyProc.once("exit", () => { clearTimeout(timer); r(); }); });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("laya start preloads by default and --no-preload opts out", () => {
  assert.equal(parseArgs(["start"]).options.preload, undefined);
  assert.equal(parseArgs(["start", "--no-preload"]).options.preload, false);
  assert.equal(parseArgs(["start", "--preload"]).options.preload, true);
  const src = fs.readFileSync(fileURLToPath(new URL("../scripts/laya-service.mjs", import.meta.url)), "utf8");
  assert.match(src, /const preload = args\.preload \?\? true;/);
  assert.match(src, /\.\.\.\(preload \? \["--preload"\] : \[\]\)/);
});

test("recall asks the tuned three-way memory-need question alone and maps project_history to requires_memory", () => {
  const script = String.raw`
import runpy, sys, types
calls = []
class FakeAgent:
    def predict(self, state, questions):
        calls.append((dict(state), sorted(questions)))
        if "memory_need" in questions:
            return {"answers": {"memory_need": {"probabilities": {"project_history": 0.83, "self_contained": 0.15, "chitchat": 0.02}, "confidence": 0.8}}}
        return {"answers": {"scope": {"probabilities": {"project": 0.7, "global": 0.2, "unknown": 0.1}},
                            "category": {"probabilities": {"pitfall": 0.1, "decision": 0.8, "knowledge": 0.1}, "confidence": 0.9}}}
sys.modules["laya_mlx"] = types.SimpleNamespace(load=lambda name: FakeAgent())
ns = runpy.run_path(sys.argv[1])
out = ns["MlxBackend"]("m").predict("what did we decide about retries?", {"project_id": "demo"})
assert calls[0] == ({"text": "what did we decide about retries?"}, ["memory_need"]), calls
assert calls[1][1] == ["category", "scope"] and calls[1][0]["project_id"] == "demo", calls
assert abs(out["requires_memory"] - 0.83) < 1e-9 and abs(out["confidence"] - 0.8) < 1e-9, out
assert out["scope"]["project"] == 0.7 and out["categories"]["decision"] == 0.8, out
print("three-way recall mapping passed")
`;
  const result = spawnSync(python.command, [...python.args, "-c", script, SERVICE_PY], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /three-way recall mapping passed/);
});
