import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  clearServiceStoppedMarker,
  getRestartStatePaths,
  markServiceStopped,
  requestServiceAutoRestart,
  serviceWasPreviouslyHealthy
} from "../lib/memory-router/auto-restart.js";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { writeStateCache } from "../lib/memory-router/cache.js";

const testPythonPath = (layaDir) => process.platform === "win32"
  ? path.join(layaDir, "venv", "Scripts", "python.exe")
  : path.join(layaDir, "venv", "bin", "python");

test("auto-restart state paths support Windows service layouts", () => {
  assert.deepEqual(
    getRestartStatePaths("C:\\Users\\Ada\\.laya\\service.json", { platform: "win32" }),
    {
      layaDir: "C:\\Users\\Ada\\.laya",
      venvDir: "C:\\Users\\Ada\\.laya\\venv",
      stopMarker: "C:\\Users\\Ada\\.laya\\.autostart-disabled",
      lockFile: "C:\\Users\\Ada\\.laya\\.autostart.lock"
    }
  );
});

test("automatic restart is locked, detached, throttled, and suppressed by explicit stop", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-auto-restart-"));
  const layaDir = path.join(tmpDir, ".laya");
  const serviceFile = path.join(layaDir, "service.json");
  const pythonPath = testPythonPath(layaDir);
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, "");

  let spawnArgs = null;
  const fakeSpawn = (command, args, options) => {
    spawnArgs = { command, args, options };
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  const processApi = {
    pid: 4312,
    execPath: process.execPath,
    env: {},
    kill() { const err = new Error("gone"); err.code = "ESRCH"; throw err; }
  };

  try {
    const result = requestServiceAutoRestart(serviceFile, { spawn: fakeSpawn, processApi, now: 1000 });
    assert.deepEqual(result, { scheduled: true, reason: "unexpected_service_exit" });
    assert.equal(spawnArgs.args[1], "start");
    assert.ok(spawnArgs.args.includes("--recovery"));
    assert.equal(spawnArgs.args.at(-1), tmpDir);
    assert.equal(spawnArgs.options.detached, true);
    assert.equal(requestServiceAutoRestart(serviceFile, { spawn: fakeSpawn, processApi, now: 1001 }).reason, "restart_throttled");

    assert.equal(markServiceStopped(serviceFile), true);
    assert.equal(requestServiceAutoRestart(serviceFile, { spawn: fakeSpawn, processApi, now: 1002 }).reason, "user_stopped");
    assert.equal(clearServiceStoppedMarker(serviceFile), true);
    assert.equal(fs.existsSync(path.join(layaDir, ".autostart-disabled")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("automatic restart lock does not stay stuck to a long-lived host process", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-auto-restart-owner-pid-"));
  const layaDir = path.join(tmpDir, ".laya");
  const serviceFile = path.join(layaDir, "service.json");
  const pythonPath = testPythonPath(layaDir);
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, "");

  let childPid = 70001;
  const processApi = {
    pid: 5151,
    execPath: process.execPath,
    env: {},
    kill(pid) {
      if (pid === 5151) return;
      const error = new Error("process is gone");
      error.code = "ESRCH";
      throw error;
    }
  };
  const fakeSpawn = () => {
    const child = Object.assign(new EventEmitter(), { pid: childPid++, unref() {} });
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };

  try {
    assert.equal(requestServiceAutoRestart(serviceFile, { spawn: fakeSpawn, processApi }).scheduled, true);
    await new Promise((resolve) => setImmediate(resolve));

    // The requesting host is still alive, but the recovery child has exited
    // and the normal retry throttle has elapsed.
    const retryAt = Date.now() + 31000;
    assert.equal(requestServiceAutoRestart(serviceFile, { spawn: fakeSpawn, processApi, now: retryAt }).scheduled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("expired legacy auto-restart lock is not kept alive by its requester PID", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-auto-restart-legacy-lock-"));
  const layaDir = path.join(tmpDir, ".laya");
  const serviceFile = path.join(layaDir, "service.json");
  const pythonPath = testPythonPath(layaDir);
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, "");
  const now = Date.now();
  const lockFile = path.join(layaDir, ".autostart.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 5151, startedAt: now - 45000, finishedAt: now - 45000 }));
  const processApi = {
    pid: 5151,
    execPath: process.execPath,
    env: {},
    kill() { return; }
  };

  try {
    const result = requestServiceAutoRestart(serviceFile, {
      processApi,
      spawn: () => Object.assign(new EventEmitter(), { pid: 70002, unref() {} }),
      now
    });
    assert.equal(result.scheduled, true);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).version, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("previous-health evidence is required before missing-service recovery", () => {
  const endpoint = "http://127.0.0.1:18791";
  assert.equal(serviceWasPreviouslyHealthy(null, 1000), false);
  assert.equal(serviceWasPreviouslyHealthy({
    lastDiscovery: { endpoint, checkedAt: 900 },
    endpoints: { [endpoint]: { health: { status: "ok" } } }
  }, 1000), true);
  assert.equal(serviceWasPreviouslyHealthy({
    lastDiscovery: { endpoint, checkedAt: 100 },
    endpoints: { [endpoint]: { health: { status: "ok" } } }
  }, 1000, 500), false);
});

test("auto router schedules recovery only when a previously healthy service disappears", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-router-recovery-"));
  const cachePath = path.join(tmpDir, "cache.json");
  const serviceFile = path.join(tmpDir, ".laya", "service.json");
  const endpoint = "http://127.0.0.1:18791";
  const now = Date.now();
  fs.mkdirSync(path.dirname(serviceFile), { recursive: true });
  writeStateCache(cachePath, {
    lastDiscovery: { endpoint, checkedAt: now },
    health: { status: "ok", modelStatus: "ready", checkedAt: now }
  }, { endpoint });

  let restartCalls = 0;
  let networkCalls = 0;
  const router = new MemoryRouter({ mode: "auto", serviceFile }, {
    useCache: true,
    cachePath,
    fetch: async () => { networkCalls += 1; throw new Error("must not probe while missing"); },
    requestServiceAutoRestart: (file) => {
      assert.equal(file, serviceFile);
      restartCalls += 1;
      return { scheduled: true };
    },
    timers: {
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout() {}
    }
  });

  try {
    const result = await router.evaluateRecall("What was the previous decision about project architecture?");
    assert.equal(result.reason, "service_restart_scheduled");
    assert.equal(result.blocked, false);
    assert.equal(restartCalls, 1);
    assert.equal(networkCalls, 0);
  } finally {
    router.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a dead trusted service PID schedules recovery without delaying this turn", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-router-dead-pid-"));
  const layaDir = path.join(tmpDir, ".laya");
  const serviceFile = path.join(layaDir, "service.json");
  fs.mkdirSync(layaDir, { recursive: true });
  fs.writeFileSync(serviceFile, JSON.stringify({
    service: "laya-memory-judge",
    api_version: "1",
    endpoint: "http://127.0.0.1:18791",
    token: "dead-process-test-token",
    pid: 43210,
    instance_id: "dead-service-test"
  }), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(serviceFile, 0o600);

  let restartCalls = 0;
  let networkCalls = 0;
  const router = new MemoryRouter({ mode: "auto", serviceFile }, {
    isPidRunning: () => false,
    requestServiceAutoRestart: () => {
      restartCalls += 1;
      return { scheduled: true };
    },
    fetch: async () => { networkCalls += 1; throw new Error("dead process must not be probed"); },
    timers: {
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {}
    }
  });

  try {
    const result = await router.evaluateRecall("How should I handle this ambiguous architecture decision?");
    assert.equal(result.reason, "service_restart_scheduled");
    assert.equal(result.blocked, false);
    assert.equal(restartCalls, 1);
    assert.equal(networkCalls, 0);
  } finally {
    router.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("first-use missing service does not auto-install or auto-start Laya", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-router-first-use-"));
  let restartCalls = 0;
  const router = new MemoryRouter({ mode: "auto", serviceFile: path.join(tmpDir, ".laya", "service.json") }, {
    useCache: true,
    cachePath: path.join(tmpDir, "empty-cache.json"),
    requestServiceAutoRestart: () => {
      restartCalls += 1;
      return { scheduled: true };
    },
    timers: {
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {}
    }
  });
  try {
    const result = await router.evaluateRecall("What should I remember about this design choice?");
    assert.equal(result.reason, "no_trusted_service");
    assert.equal(restartCalls, 0);
  } finally {
    router.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
