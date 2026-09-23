import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVICE_CLI = fileURLToPath(new URL("../../scripts/laya-service.mjs", import.meta.url));
const RETRY_DELAY_MS = 30000;
const LOCK_STALE_MS = 120000;

export function getRestartStatePaths(serviceFile, options = {}) {
  const pathModule = options.pathModule ?? ((options.platform ?? process.platform) === "win32" ? path.win32 : path);
  if (typeof serviceFile !== "string" || pathModule.basename(serviceFile) !== "service.json") return null;
  const layaDir = pathModule.dirname(serviceFile);
  if (pathModule.basename(layaDir) !== ".laya") return null;
  return {
    layaDir,
    venvDir: pathModule.join(layaDir, "venv"),
    stopMarker: pathModule.join(layaDir, ".autostart-disabled"),
    lockFile: pathModule.join(layaDir, ".autostart.lock")
  };
}

export function isPidRunning(pid, processApi = process) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function markServiceStopped(serviceFile, options = {}) {
  const paths = getRestartStatePaths(serviceFile, options);
  if (!paths) return false;
  const fileSystem = options.fs ?? fs;
  try {
    fileSystem.mkdirSync(paths.layaDir, { recursive: true, mode: 0o700 });
    const existing = fileSystem.lstatSync(paths.stopMarker);
    if (existing) return existing.isFile() || existing.isSymbolicLink();
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  try {
    const fd = fileSystem.openSync(paths.stopMarker, "wx", 0o600);
    try { fileSystem.writeFileSync(fd, `${Date.now()}\n`, "utf8"); }
    finally { fileSystem.closeSync(fd); }
    if ((options.platform ?? process.platform) !== "win32") {
      try { fileSystem.chmodSync(paths.stopMarker, 0o600); } catch {}
    }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return true;
    return false;
  }
}

export function clearServiceStoppedMarker(serviceFile, options = {}) {
  const paths = getRestartStatePaths(serviceFile, options);
  if (!paths) return false;
  const fileSystem = options.fs ?? fs;
  try {
    if (fileSystem.existsSync(paths.stopMarker)) fileSystem.unlinkSync(paths.stopMarker);
    return true;
  } catch {
    return false;
  }
}

function pythonExists(venvDir, platform = process.platform, fileSystem = fs, pathModule = path) {
  const pythonPath = platform === "win32"
    ? pathModule.join(venvDir, "Scripts", "python.exe")
    : pathModule.join(venvDir, "bin", "python");
  return fileSystem.existsSync(pythonPath);
}

export function requestServiceAutoRestart(serviceFile, options = {}) {
  const paths = getRestartStatePaths(serviceFile, options);
  const fileSystem = options.fs ?? fs;
  const platform = options.platform ?? process.platform;
  const pathModule = options.pathModule ?? (platform === "win32" ? path.win32 : path);
  const now = options.now ?? Date.now();
  const spawn = options.spawn ?? nodeSpawn;
  const processApi = options.processApi ?? process;

  if (!paths || !fileSystem.existsSync(paths.venvDir) || !pythonExists(paths.venvDir, platform, fileSystem, pathModule)) {
    return { scheduled: false, reason: "not_installed" };
  }
  try {
    const dirStat = fileSystem.lstatSync(paths.layaDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      return { scheduled: false, reason: "unsafe_service_directory" };
    }
  } catch {
    return { scheduled: false, reason: "unsafe_service_directory" };
  }
  if (!fileSystem.existsSync(SERVICE_CLI)) return { scheduled: false, reason: "launcher_missing" };
  if (fileSystem.existsSync(paths.stopMarker)) return { scheduled: false, reason: "user_stopped" };

  try {
    if (fileSystem.existsSync(paths.lockFile)) {
      let lock = null;
      try { lock = JSON.parse(fileSystem.readFileSync(paths.lockFile, "utf8")); } catch {}
      const age = lock && Number.isFinite(lock.startedAt) ? now - lock.startedAt : LOCK_STALE_MS;
      const running = isPidRunning(lock?.pid, processApi);
      const completedRecently = Number.isFinite(lock?.finishedAt) && now - lock.finishedAt < RETRY_DELAY_MS;
      if (running || completedRecently || age < LOCK_STALE_MS) {
        return { scheduled: false, reason: "restart_throttled" };
      }
      fileSystem.unlinkSync(paths.lockFile);
    }

    const lock = { pid: processApi.pid, startedAt: now, finishedAt: null };
    const fd = fileSystem.openSync(paths.lockFile, "wx", 0o600);
    try {
      fileSystem.writeFileSync(fd, JSON.stringify(lock), "utf8");
    } finally {
      fileSystem.closeSync(fd);
    }

    if (fileSystem.existsSync(paths.stopMarker)) {
      fileSystem.unlinkSync(paths.lockFile);
      return { scheduled: false, reason: "user_stopped" };
    }

    const layaHome = pathModule.dirname(paths.layaDir);
    const child = spawn(processApi.execPath, [SERVICE_CLI, "start", "--recovery", "--home", layaHome], {
      cwd: path.dirname(path.dirname(SERVICE_CLI)),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: options.env ?? processApi.env
    });
    const markFinished = () => {
      try {
        const latest = JSON.parse(fileSystem.readFileSync(paths.lockFile, "utf8"));
        if (latest.pid === processApi.pid && latest.startedAt === now) {
          latest.finishedAt = Date.now();
          fileSystem.writeFileSync(paths.lockFile, JSON.stringify(latest), { mode: 0o600 });
        }
      } catch {}
    };
    child.once?.("error", markFinished);
    child.once?.("exit", markFinished);
    child.unref?.();
    return { scheduled: true, reason: "unexpected_service_exit" };
  } catch {
    return { scheduled: false, reason: "restart_unavailable" };
  }
}

export function serviceWasPreviouslyHealthy(cacheData, now = Date.now(), maxAgeMs = 86400000) {
  const lastDiscovery = cacheData?.lastDiscovery;
  if (!lastDiscovery || typeof lastDiscovery.endpoint !== "string" || !Number.isFinite(lastDiscovery.checkedAt)) return false;
  if (lastDiscovery.checkedAt <= 0 || now - lastDiscovery.checkedAt > maxAgeMs || now < lastDiscovery.checkedAt) return false;
  const health = cacheData?.endpoints?.[lastDiscovery.endpoint]?.health;
  return health?.status === "ok" || health?.status === "degraded";
}
