#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPython } from "./python.mjs";
import { clearServiceStoppedMarker, markServiceStopped } from "../lib/memory-router/auto-restart.js";
import { LayaClient } from "../lib/memory-router/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVICE_PY = path.join(REPO_ROOT, "lib", "laya-service", "service.py");

export function getLayaDir(customHome = null) {
  const home = customHome || process.env.LAYA_HOME || os.homedir();
  const dir = path.join(home, ".laya");
  return dir;
}

export function ensureLayaDir(customHome = null) {
  const dir = getLayaDir(customHome);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }
  return dir;
}

export function getDefaultVenvPath(customHome = null) {
  return path.join(getLayaDir(customHome), "venv");
}

export function getDefaultServiceFilePath(customHome = null) {
  return path.join(getLayaDir(customHome), "service.json");
}

export const LAYA_HF_CACHE_DIRS = [
  "models--aac6fef--laya-multilingual-mlx",
  "models--convaiinnovations--laya-multilingual"
];

export function getDefaultPidFilePath(customHome = null) {
  return path.join(getLayaDir(customHome), "daemon.pid");
}

export function readPidFile(pidFilePath) {
  try {
    if (!fs.existsSync(pidFilePath)) return null;
    const raw = fs.readFileSync(pidFilePath, "utf8").trim();
    if (raw.startsWith("{")) {
      const data = JSON.parse(raw);
      return {
        pid: typeof data.pid === "number" ? data.pid : Number(data.pid),
        instance_id: typeof data.instance_id === "string" ? data.instance_id : null
      };
    }
    const num = Number(raw);
    return isNaN(num) ? null : { pid: num, instance_id: null };
  } catch {
    return null;
  }
}

export function findUv(customUvPath = null, options = {}) {
  if (customUvPath && fs.existsSync(customUvPath)) {
    return customUvPath;
  }
  const env = options.env || process.env;
  if (env.UV_PATH && fs.existsSync(env.UV_PATH)) {
    return env.UV_PATH;
  }

  const homedir = options.homedir || os.homedir();
  const platform = options.platform || process.platform;
  const execFn = options.execFn || spawnSync;

  const candidates = [
    path.join(homedir, ".local", "bin", platform === "win32" ? "uv.exe" : "uv"),
    path.join(homedir, ".cargo", "bin", platform === "win32" ? "uv.exe" : "uv"),
    platform === "win32" ? "uv.exe" : "uv"
  ];

  for (const cand of candidates) {
    try {
      const res = execFn(cand, ["--version"], { encoding: "utf8", windowsHide: true });
      if (res && res.status === 0) {
        return cand;
      }
    } catch {}
  }
  return null;
}

export function detectBackend(override = null, platform = process.platform, arch = process.arch) {
  if (override && ["mlx", "pytorch", "mock"].includes(override)) {
    return override;
  }
  const isAppleSilicon = platform === "darwin" && arch === "arm64";
  return isAppleSilicon ? "mlx" : "pytorch";
}

export function getVenvPython(venvDir) {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

export async function checkServiceHealth(endpoint, token, timeoutMs = 1000) {
  try {
    const health = await new LayaClient(endpoint, { token }).healthCheck({ timeout: timeoutMs });
    return health;
  } catch {
    return null;
  }
}

export function isPidRunning(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // Process exists but lacks permission
  }
}

export function maskToken(token) {
  if (!token || typeof token !== "string") return "none";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export function safeCompareTokens(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function matchesServiceIdentity(current, expected) {
  if (!current || !expected) return false;
  if (current.pid !== expected.pid) return false;
  if (expected.instance_id && current.instance_id !== expected.instance_id) return false;
  if (expected.endpoint && current.endpoint !== expected.endpoint) return false;
  if (!safeCompareTokens(current.token, expected.token)) return false;
  return true;
}

export function matchesPidIdentity(current, expected) {
  if (!current || !expected) return false;
  if (current.pid !== expected.pid) return false;
  if (expected.instance_id && current.instance_id !== expected.instance_id) return false;
  return true;
}

export function linkGlobalCli(customHome = null) {
  const scriptPath = fileURLToPath(import.meta.url);
  const homedir = customHome || process.env.LAYA_HOME || os.homedir();
  const localBin = path.join(homedir, ".local", "bin");

  try {
    if (!fs.existsSync(localBin)) {
      fs.mkdirSync(localBin, { recursive: true });
    }

    if (process.platform !== "win32") {
      try { fs.chmodSync(scriptPath, 0o755); } catch {}
      for (const name of ["laya", "laya-service"]) {
        const linkPath = path.join(localBin, name);
        try {
          if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
            fs.unlinkSync(linkPath);
          }
        } catch {}
        fs.symlinkSync(scriptPath, linkPath);
      }
      process.stdout.write(`Linked global CLI 'laya' to ${localBin}\n`);
      return true;
    } else {
      const cmdContent = `@echo off\r\nnode "${scriptPath}" %*\r\n`;
      for (const name of ["laya.cmd", "laya-service.cmd"]) {
        const cmdPath = path.join(localBin, name);
        fs.writeFileSync(cmdPath, cmdContent, "utf8");
      }
      process.stdout.write(`Linked global CLI 'laya.cmd' to ${localBin}\n`);
      return true;
    }
  } catch {
    return false;
  }
}

export function unlinkGlobalCli(customHome = null) {
  const scriptPath = fileURLToPath(import.meta.url);
  const homedir = customHome || process.env.LAYA_HOME || os.homedir();
  const localBin = path.join(homedir, ".local", "bin");

  try {
    if (process.platform !== "win32") {
      for (const name of ["laya", "laya-service"]) {
        const linkPath = path.join(localBin, name);
        try {
          if (fs.lstatSync(linkPath).isSymbolicLink()) {
            const target = fs.readlinkSync(linkPath);
            if (target === scriptPath || path.resolve(localBin, target) === scriptPath) {
              fs.unlinkSync(linkPath);
            }
          }
        } catch {}
      }
    } else {
      for (const name of ["laya.cmd", "laya-service.cmd"]) {
        const cmdPath = path.join(localBin, name);
        try {
          if (fs.existsSync(cmdPath)) {
            const content = fs.readFileSync(cmdPath, "utf8");
            if (content.includes(scriptPath)) {
              fs.unlinkSync(cmdPath);
            }
          }
        } catch {}
      }
    }
  } catch {}
}

// ------------------------------------------------------------------------- Subcommands

export async function installCommand(args = {}) {
  const customHome = args.home || null;
  ensureLayaDir(customHome);
  const venvDir = args.venv || getDefaultVenvPath(customHome);
  const backend = detectBackend(args.backend);
  const uvPath = findUv(args.uv);

  if (!uvPath) {
    throw new Error(
      "uv package manager not found. Please install uv first:\n" +
      "  macOS / Linux: curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
      "  Windows: winget install --id=astral-sh.uv\n"
    );
  }

  process.stdout.write(`Setting up Laya virtual environment for backend: ${backend}\n`);
  process.stdout.write(`Target venv path: ${venvDir}\n`);

  fs.mkdirSync(path.dirname(venvDir), { recursive: true });

  // 1. Create venv using Python 3.12 (or 3.11)
  if (!fs.existsSync(venvDir)) {
    process.stdout.write("Creating isolated virtualenv with uv...\n");
    const venvRes = spawnSync(uvPath, ["venv", "--python", "3.12", venvDir], {
      stdio: "inherit",
      windowsHide: true
    });
    if (venvRes.status !== 0) {
      // Fallback to python 3.11 if 3.12 is not installed locally
      const fallbackRes = spawnSync(uvPath, ["venv", "--python", "3.11", venvDir], {
        stdio: "inherit",
        windowsHide: true
      });
      if (fallbackRes.status !== 0) {
        throw new Error("Failed to create Python virtualenv with uv.");
      }
    }
  }

  const pythonBin = getVenvPython(venvDir);
  if (!fs.existsSync(pythonBin)) {
    throw new Error(`Python binary not found at ${pythonBin}`);
  }

  // 2. Install required packages according to backend with exact pinning
  if (backend === "mlx") {
    process.stdout.write("Installing laya-mlx==0.2.0 (Apple Silicon native)...\n");
    const pipRes = spawnSync(uvPath, ["pip", "install", "--python", pythonBin, "laya-mlx==0.2.0"], {
      stdio: "inherit",
      windowsHide: true
    });
    if (pipRes.status !== 0) {
      throw new Error("Failed to install laya-mlx package.");
    }

    // Smoke test import
    const smokeRes = spawnSync(pythonBin, ["-c", "import laya_mlx; print(getattr(laya_mlx, '__version__', 'ok'))"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (smokeRes.status !== 0) {
      throw new Error(`laya-mlx smoke test failed: ${smokeRes.stderr}`);
    }
  } else if (backend === "pytorch") {
    process.stdout.write("Installing laya==0.3.5 (PyTorch official backend)...\n");
    const pipRes = spawnSync(uvPath, ["pip", "install", "--python", pythonBin, "laya==0.3.5"], {
      stdio: "inherit",
      windowsHide: true
    });
    if (pipRes.status !== 0) {
      throw new Error("Failed to install laya package.");
    }

    // Smoke test import
    const smokeRes = spawnSync(pythonBin, ["-c", "import laya; print(getattr(laya, '__version__', 'ok'))"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (smokeRes.status !== 0) {
      throw new Error(`laya smoke test failed: ${smokeRes.stderr}`);
    }
  } else if (backend === "mock") {
    process.stdout.write("Mock backend selected: no external packages required.\n");
  }

  // 3. Download model: default true, skip if --skip-model is passed
  const shouldDownload = backend !== "mock" && !args.skipModel;
  if (shouldDownload) {
    process.stdout.write("Downloading model weights into local cache...\n");
    const downloadScript = backend === "mlx"
      ? "import laya_mlx; laya_mlx.load('aac6fef/laya-multilingual-mlx')"
      : "import laya; laya.load('convaiinnovations/laya-multilingual')";
    const dlRes = spawnSync(pythonBin, ["-c", downloadScript], {
      stdio: "inherit",
      windowsHide: true
    });
    if (dlRes.status !== 0) {
      throw new Error(`Model download failed with exit code ${dlRes.status}. Check your network connection.`);
    }
    process.stdout.write("Model weights successfully downloaded and verified.\n");
  } else if (args.skipModel) {
    process.stdout.write("Skipping model download as requested (--skip-model).\n");
  }

  // 4. Register global CLI symlink/cmd so `laya` works directly in terminal
  linkGlobalCli(customHome);

  process.stdout.write("\nLaya installation complete!\n");
  return 0;
}

export async function statusCommand(args = {}) {
  const customHome = args.home || null;
  const serviceFile = args.serviceFile || getDefaultServiceFilePath(customHome);
  const venvDir = args.venv || getDefaultVenvPath(customHome);

  if (!fs.existsSync(serviceFile)) {
    if (!fs.existsSync(venvDir)) {
      process.stdout.write("Laya service status: STOPPED (not installed: run 'laya install' or 'npm run laya:install' to set up)\n");
    } else {
      process.stdout.write("Laya service status: STOPPED (service is not running: run 'laya start' to launch)\n");
    }
    return 0;
  }

  let serviceData;
  try {
    serviceData = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
  } catch {
    process.stdout.write("Laya service status: CORRUPT (invalid service.json)\n");
    return 1;
  }

  const pid = serviceData.pid;
  const endpoint = serviceData.endpoint;
  const token = serviceData.token;

  const running = isPidRunning(pid);
  if (!running) {
    process.stdout.write(`Laya service status: DEAD (stale service.json with PID ${pid})\n`);
    return 1;
  }

  const health = await checkServiceHealth(endpoint, token, 1500);
  if (!health) {
    process.stdout.write(`Laya service status: UNRESPONSIVE (process ${pid} running, but /health timed out or failed)\n`);
    return 1;
  }

  const healthInstance = health.instance_id ?? health.instanceId;
  if (health.service !== "laya-memory-judge" || (serviceData.instance_id && healthInstance && healthInstance !== serviceData.instance_id)) {
    process.stdout.write(`Laya service status: UNRESPONSIVE (service identity mismatch on endpoint ${endpoint})\n`);
    return 1;
  }

  process.stdout.write("=== Laya Local Service Status ===\n");
  process.stdout.write(`  State:        RUNNING\n`);
  process.stdout.write(`  PID:          ${pid}\n`);
  process.stdout.write(`  Endpoint:     ${endpoint}\n`);
  process.stdout.write(`  Backend:      ${health.backend || "unknown"}\n`);
  process.stdout.write(`  Model:        ${health.model || "default"}\n`);
  process.stdout.write(`  Model Status: ${health.model_status || health.modelStatus || "unknown"}\n`);
  process.stdout.write(`  Token:        ${maskToken(token)}\n`);
  process.stdout.write("=================================\n");
  return 0;
}

export async function startCommand(args = {}) {
  const customHome = args.home || null;
  const layaDir = ensureLayaDir(customHome);
  const serviceFile = args.serviceFile || getDefaultServiceFilePath(customHome);
  const pidFile = args.pidFile || getDefaultPidFilePath(customHome);
  const venvDir = args.venv || getDefaultVenvPath(customHome);
  const backend = detectBackend(args.backend);
  const idleUnloadSeconds = args.idleUnloadSeconds ?? 900;
  const transport = args.transport ?? "auto";
  if (!["auto", "http", "uds"].includes(transport)) throw new TypeError("--transport must be auto, http, or uds");
  if (process.platform === "win32" && transport === "uds") throw new TypeError("UDS is not supported on Windows; use auto or http");
  if (!Number.isInteger(idleUnloadSeconds) || idleUnloadSeconds < 0 || idleUnloadSeconds > 86400) {
    throw new TypeError("--idle-unload-seconds must be an integer between 0 and 86400");
  }
  if (args.recovery) {
    const paths = path.join(layaDir, ".autostart-disabled");
    if (fs.existsSync(paths)) {
      process.stdout.write("Automatic recovery suppressed because the service was explicitly stopped. Run 'laya start' to resume.\n");
      return 0;
    }
  } else {
    clearServiceStoppedMarker(serviceFile);
  }

  // Check if already running
  if (fs.existsSync(serviceFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
      if (isPidRunning(data.pid)) {
        const health = await checkServiceHealth(data.endpoint, data.token, 1000);
        if (health) {
          process.stdout.write(`Laya service is already running on ${data.endpoint} (PID: ${data.pid})\n`);
          return 0;
        }
      }
    } catch {}
  }

  let pythonBin = args.python || null;
  let pythonArgs = [];
  if (pythonBin) {
    // User passed explicit python binary
  } else {
    const venvPy = getVenvPython(venvDir);
    if (fs.existsSync(venvPy)) {
      pythonBin = venvPy;
    } else if (backend === "mock") {
      const py = findPython();
      pythonBin = py.command;
      pythonArgs = py.args || [];
    } else {
      throw new Error(
        `Laya Python environment not found at ${venvDir}.\n` +
        "Please run 'npm run laya:install' first."
      );
    }
  }

  process.stdout.write(`Starting Laya service (Backend: ${backend})...\n`);

  // Securely deliver token via permissions-protected temporary file (deleted upon startup)
  const token = args.token || crypto.randomBytes(32).toString("hex");
  const tokenFileName = `.token_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  const tokenFilePath = path.join(layaDir, tokenFileName);
  fs.writeFileSync(tokenFilePath, token + "\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(tokenFilePath, 0o600); } catch {}
  }

  const pyArgs = [
    SERVICE_PY,
    "--backend", backend,
    "--idle-unload-seconds", String(idleUnloadSeconds),
    "--service-file", serviceFile,
    "--pid-file", pidFile,
    "--token-file", tokenFilePath,
    "--transport", transport,
    "--socket-file", path.join(path.dirname(serviceFile), "service.sock")
  ];

  if (args.port) {
    pyArgs.push("--port", String(args.port));
  }

  if (args.model) {
    pyArgs.push("--model", args.model);
  }

  // An explicit stop can race a background recovery attempt. Check immediately
  // before spawning; stopCommand writes the marker before inspecting service.json.
  if (args.recovery && fs.existsSync(path.join(layaDir, ".autostart-disabled"))) {
    try { fs.unlinkSync(tokenFilePath); } catch {}
    process.stdout.write("Automatic recovery suppressed because the service was explicitly stopped.\n");
    return 0;
  }

  const child = spawn(pythonBin, [...pythonArgs, ...pyArgs], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...(args.env || {}) }
  });

  child.unref();

  // Wait for service.json to be created and health check to respond
  const maxWaitMs = args.timeoutMs || 45000;
  const pollIntervalMs = 250;
  const startTime = Date.now();

  let started = false;
  let errorOutput = "";

  child.stderr?.on("data", (chunk) => {
    errorOutput += chunk.toString();
  });
  child.stdout?.on("data", (chunk) => {
    const str = chunk.toString();
    if (str.includes("listening on")) {
      started = true;
    }
  });

  while (Date.now() - startTime < maxWaitMs) {
    if (!isPidRunning(child.pid)) {
      try { fs.unlinkSync(tokenFilePath); } catch {}
      throw new Error(`Laya service process terminated unexpectedly.\n${errorOutput}`);
    }

    if (fs.existsSync(serviceFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
        if (data.pid === child.pid) {
          const health = await checkServiceHealth(data.endpoint, data.token, 500);
          const healthInstance = health?.instance_id ?? health?.instanceId;
          if (health && (!data.instance_id || !healthInstance || healthInstance === data.instance_id)) {
            if (args.recovery && fs.existsSync(path.join(layaDir, ".autostart-disabled"))) {
              try { await stopCommand({ home: customHome, serviceFile, pidFile }); } catch {}
              try { child.stdout?.destroy(); } catch {}
              try { child.stderr?.destroy(); } catch {}
              try { fs.unlinkSync(tokenFilePath); } catch {}
              process.stdout.write("Automatic recovery cancelled after an explicit stop request.\n");
              return 0;
            }
            process.stdout.write(
              `Laya service started successfully on ${data.endpoint} (PID: ${data.pid}, Backend: ${health.backend})\n`
            );
            process.stdout.write(`Token: ${maskToken(data.token)}\n`);
            try { child.stdout?.destroy(); } catch {}
            try { child.stderr?.destroy(); } catch {}
            try { fs.unlinkSync(tokenFilePath); } catch {}
            return 0;
          }
        }
      } catch {}
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Timeout reached! Kill the child process we launched to prevent orphaned background processes
  try {
    if (isPidRunning(child.pid)) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
      } else {
        process.kill(child.pid, "SIGTERM");
        setTimeout(() => {
          try { process.kill(child.pid, "SIGKILL"); } catch {}
        }, 1000).unref();
      }
    }
  } catch {}

  try { fs.unlinkSync(tokenFilePath); } catch {}
  try {
    if (fs.existsSync(serviceFile)) {
      const data = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
      if (data.pid === child.pid && safeCompareTokens(data.token, token)) fs.unlinkSync(serviceFile);
    }
  } catch {}
  try {
    if (fs.existsSync(pidFile)) {
      const currentPid = readPidFile(pidFile);
      if (currentPid && currentPid.pid === child.pid) fs.unlinkSync(pidFile);
    }
  } catch {}

  throw new Error(`Timeout waiting for Laya service to start within ${maxWaitMs / 1000}s. Terminated spawned child to prevent orphaned process.\n${errorOutput}`);
}

export async function stopCommand(args = {}) {
  const customHome = args.home || null;
  const serviceFile = args.serviceFile || getDefaultServiceFilePath(customHome);
  const pidFile = args.pidFile || getDefaultPidFilePath(customHome);

  // Persist intentional shutdown before reading service metadata so a concurrent
  // recovery process either sees the marker or is caught by its final check.
  markServiceStopped(serviceFile);

  let serviceData = null;
  if (fs.existsSync(serviceFile)) {
    try {
      serviceData = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    } catch {}
  }

  const pidInfo = readPidFile(pidFile);
  let pid = serviceData?.pid || pidInfo?.pid || null;

  if (!pid && !serviceData) {
    process.stdout.write("No active Laya service found. Nothing to stop.\n");
    return 0;
  }

  // If process is already dead: safely clean up stale metadata if matching token/pid
  if (pid && !isPidRunning(pid)) {
    if (serviceData && fs.existsSync(serviceFile)) {
      try {
        const current = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
        if (matchesServiceIdentity(current, serviceData)) fs.unlinkSync(serviceFile);
      } catch {}
    }
    if (pidInfo && fs.existsSync(pidFile)) {
      try {
        const currentPid = readPidFile(pidFile);
        if (matchesPidIdentity(currentPid, pidInfo)) fs.unlinkSync(pidFile);
      } catch {}
    }
    process.stdout.write("Cleaned up stale service metadata.\n");
    return 0;
  }

  // Running service: require authenticated local POST /shutdown
  if (!serviceData?.endpoint || !serviceData?.token || !serviceData?.instance_id) {
    throw new Error(
      `Cannot stop Laya service at PID ${pid}: missing endpoint, token, or instance_id in service.json.\n` +
      "Refusing to terminate unauthenticated PID to protect against PID reuse hazards."
    );
  }

  let shutdownRes;
  try {
    shutdownRes = await new LayaClient(serviceData.endpoint, { token: serviceData.token }).shutdown({
      pid: serviceData.pid,
      instanceId: serviceData.instance_id,
      timeout: 4000
    });
  } catch (err) {
    throw new Error(
      `Failed to send /shutdown to Laya service at ${serviceData.endpoint}: ${err.message}.\n` +
      "Refusing to terminate process without verified shutdown."
    );
  }

  const resJson = shutdownRes;

  if (
    !resJson ||
    resJson.service !== "laya-memory-judge" ||
    resJson.status !== "shutting_down" ||
    resJson.pid !== serviceData.pid
  ) {
    throw new Error(
      `Invalid /shutdown response from service: ${JSON.stringify(resJson)}. Expected matching service, status 'shutting_down', and pid ${serviceData.pid}.`
    );
  }

  if (!resJson.instance_id || resJson.instance_id !== serviceData.instance_id) {
    throw new Error(`Instance ID mismatch in /shutdown response: ${resJson.instance_id} != ${serviceData.instance_id}`);
  }

  // Poll up to 5 seconds to confirm process has exited
  const waitStart = Date.now();
  while (Date.now() - waitStart < 5000) {
    if (!isPidRunning(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (isPidRunning(pid)) {
    throw new Error(
      `Laya service (PID: ${pid}) acknowledged shutdown but process is still running after 5s timeout.`
    );
  }

  // Cleanup service.json and pidFile if they still belong to this service
  if (fs.existsSync(serviceFile)) {
    try {
      const current = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
      if (matchesServiceIdentity(current, serviceData)) fs.unlinkSync(serviceFile);
    } catch {}
  }
  if (fs.existsSync(pidFile)) {
    try {
      const currentPid = readPidFile(pidFile);
      if (matchesPidIdentity(currentPid, { pid, instance_id: serviceData.instance_id })) fs.unlinkSync(pidFile);
    } catch {}
  }

  process.stdout.write("Laya service stopped gracefully via /shutdown.\n");
  return 0;
}

export async function uninstallCommand(args = {}) {
  const customHome = args.home || null;
  const layaDir = getLayaDir(customHome);
  const venvDir = args.venv || getDefaultVenvPath(customHome);
  const serviceFile = args.serviceFile || getDefaultServiceFilePath(customHome);
  const pidFile = args.pidFile || getDefaultPidFilePath(customHome);

  process.stdout.write("Uninstalling Laya service...\n");

  // 1. Ensure service is stopped via authenticated /shutdown. Do NOT swallow errors!
  let serviceData = null;
  if (fs.existsSync(serviceFile)) {
    try {
      serviceData = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
    } catch {}
  }
  const pidInfo = readPidFile(pidFile);
  const pid = serviceData?.pid || pidInfo?.pid || null;

  if (pid && isPidRunning(pid)) {
    // Attempt authenticated stopCommand. If it fails, ABORT uninstall!
    await stopCommand({ home: customHome, serviceFile, pidFile });
    // Verify once more that process is not running
    if (isPidRunning(pid)) {
      throw new Error(`Cannot uninstall: Laya service (PID: ${pid}) is still running and could not be stopped.`);
    }
  }

  // 2. Remove venv directory
  if (fs.existsSync(venvDir)) {
    process.stdout.write(`Removing virtual environment at ${venvDir}...\n`);
    fs.rmSync(venvDir, { recursive: true, force: true });
  }

  // 3. Remove runtime files
  try {
    if (fs.existsSync(serviceFile)) {
      const current = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
      if (!serviceData || matchesServiceIdentity(current, serviceData)) fs.unlinkSync(serviceFile);
    }
  } catch {}
  try {
    if (fs.existsSync(pidFile)) {
      const currentPid = readPidFile(pidFile);
      if (!pidInfo || matchesPidIdentity(currentPid, pidInfo)) fs.unlinkSync(pidFile);
    }
  } catch {}

  // 4. Optionally purge ONLY Laya model cache directories if explicitly requested (P1-6)
  if (args.purgeCache) {
    process.stdout.write("Purging Laya model cache from Hugging Face hub directory...\n");
    const hubDir = path.join(os.homedir(), ".cache", "huggingface", "hub");
    if (fs.existsSync(hubDir)) {
      for (const modelDirName of LAYA_HF_CACHE_DIRS) {
        const targetDir = path.join(hubDir, modelDirName);
        if (fs.existsSync(targetDir)) {
          process.stdout.write(`  Removing ${targetDir}\n`);
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
      }
    }
  }

  // 5. Unlink global CLI command if pointing to this installation
  unlinkGlobalCli(customHome);

  // 6. Clean up temporary token files and remove .laya directory if now empty
  try {
    if (fs.existsSync(layaDir)) {
      const entries = fs.readdirSync(layaDir);
      for (const entry of entries) {
        if (entry.startsWith(".token_") || entry === ".autostart-disabled" || entry === ".autostart.lock") {
          try { fs.unlinkSync(path.join(layaDir, entry)); } catch {}
        }
      }
      if (fs.readdirSync(layaDir).length === 0) {
        fs.rmdirSync(layaDir);
      }
    }
  } catch {}

  process.stdout.write("Laya service and virtual environment successfully uninstalled.\n");
  return 0;
}

// ------------------------------------------------------------------------- CLI runner

export function parseArgs(argv) {
  const command = argv[0] || "status";
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--backend" && i + 1 < argv.length) {
      options.backend = argv[++i];
    } else if (arg === "--model" && i + 1 < argv.length) {
      options.model = argv[++i];
    } else if (arg === "--venv" && i + 1 < argv.length) {
      options.venv = argv[++i];
    } else if (arg === "--home" && i + 1 < argv.length) {
      options.home = argv[++i];
    } else if (arg === "--skip-model") {
      options.skipModel = true;
    } else if (arg === "--download-model") {
      options.skipModel = false;
    } else if (arg === "--port" && i + 1 < argv.length) {
      options.port = parseInt(argv[++i], 10);
    } else if (arg === "--transport" && i + 1 < argv.length) {
      options.transport = argv[++i];
    } else if (arg === "--idle-unload-seconds" && i + 1 < argv.length) {
      options.idleUnloadSeconds = parseInt(argv[++i], 10);
    } else if (arg === "--recovery") {
      options.recovery = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--purge-cache") {
      options.purgeCache = true;
    }
  }
  return { command, options };
}

export async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));

  try {
    if (command === "install" || command === "setup") {
      await installCommand(options);
    } else if (command === "start") {
      await startCommand(options);
    } else if (command === "stop") {
      await stopCommand(options);
    } else if (command === "status") {
      await statusCommand(options);
    } else if (command === "uninstall") {
      await uninstallCommand(options);
    } else {
      process.stderr.write(`Unknown command: ${command}. Use install, start, stop, status, or uninstall.\n`);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

let isMain = false;
try {
  if (process.argv[1]) {
    isMain = fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  }
} catch {
  isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}
if (isMain) {
  run();
}
