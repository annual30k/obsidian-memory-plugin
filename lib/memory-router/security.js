import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { resolve, normalize, relative, isAbsolute, win32 } from "node:path";
import { homedir } from "node:os";
import { validateLoopbackEndpoint } from "../config.js";

export { validateLoopbackEndpoint };

/**
 * Safely reads and validates the trusted local Laya service file.
 * Returns { endpoint, token, service } on success, or null if missing/untrusted/invalid.
 */
export function readTrustedServiceFile(filePath, options = {}) {
  const fs = options.fs ?? { existsSync, lstatSync, statSync, readFileSync };
  const platform = options.platform ?? process.platform;
  const getuid = options.getuid ?? (process.getuid ? () => process.getuid() : null);
  const pathModule = options.pathModule ?? (platform === "win32" ? win32 : { resolve, normalize, relative, isAbsolute });

  if (!filePath || typeof filePath !== "string") {
    return null;
  }

  const resolved = pathModule.resolve(filePath);

  try {
    if (!fs.existsSync(resolved)) {
      return null;
    }

    const lstat = fs.lstatSync(resolved);
    if (!lstat.isFile()) {
      return null;
    }

    // Windows home containment check using path.relative segment boundaries
    if (platform === "win32") {
      const userHome = options.homedir ? options.homedir() : homedir();
      const rel = pathModule.relative(userHome, resolved);
      const isContained = !rel.startsWith("..") && !pathModule.isAbsolute(rel) && rel !== "";
      if (!isContained && !options.allowCustomWindowsPath) {
        return null;
      }
    }

    // Limit read to 16KB to prevent denial-of-service via massive files
    if (lstat.size > 16384) {
      return null;
    }

    const raw = fs.readFileSync(resolved, "utf8");
    const data = JSON.parse(raw);

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }

    if (data.service !== "laya-memory-judge") {
      return null;
    }

    const version = data.api_version ?? data.apiVersion;
    if (version !== "1") {
      return null;
    }

    const endpoint = validateLoopbackEndpoint(data.endpoint);
    let token = null;
    if (typeof data.token === "string" && data.token.length > 0) {
      if (data.token.length > 512 || /[\u0000-\u001f\u007f]/u.test(data.token)) {
        return null;
      }
      token = data.token;
    }

    // POSIX security checks
    if (platform !== "win32") {
      if (typeof getuid === "function") {
        const currentUid = getuid();
        if (lstat.uid !== currentUid) {
          // File not owned by current user
          return null;
        }
      }
      if (token) {
        // When service file contains a secret token, POSIX strictly mandates 0600 (no group or other access)
        if ((lstat.mode & 0o077) !== 0) {
          return null;
        }
      } else {
        // Without token, standard safe permissions (no group or other write access, e.g. 0600 or 0644)
        if ((lstat.mode & 0o022) !== 0) {
          return null;
        }
      }
    }

    let instance_id = null;
    const rawInstanceId = data.instance_id ?? data.instanceId;
    if (rawInstanceId !== undefined && rawInstanceId !== null) {
      if (typeof rawInstanceId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(rawInstanceId)) {
        return null;
      }
      instance_id = rawInstanceId;
    }

    let pid = null;
    if (data.pid !== undefined && data.pid !== null) {
      if (!Number.isInteger(data.pid) || data.pid <= 0) {
        return null;
      }
      pid = data.pid;
    }

    return {
      service: data.service,
      endpoint,
      token,
      instance_id,
      instanceId: instance_id,
      pid
    };
  } catch {
    // Treat any file/JSON/validation error as untrusted service file
    return null;
  }
}
