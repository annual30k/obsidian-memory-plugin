/**
 * Put a plugin command on the user's PATH: a symlink in ~/.local/bin (a .cmd shim on Windows), the
 * same place `laya install` links `laya`. OBSIDIAN_MEMORY_BIN_DIR moves the folder (tests, custom setups).
 * Never replaces a file that is not one of ours.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const omemScript = () => fileURLToPath(new URL("../scripts/omem.mjs", import.meta.url));

export function binDir({ env = process.env, home = os.homedir() } = {}) {
  const override = env.OBSIDIAN_MEMORY_BIN_DIR?.trim();
  return override && path.isAbsolute(override) ? override : path.join(home, ".local", "bin");
}

function isOurs(file, platform) {
  try {
    if (platform === "win32") return /node ".*[\\/]scripts[\\/][\w-]+\.mjs" %\*/u.test(fs.readFileSync(file, "utf8"));
    const st = fs.lstatSync(file);
    return st.isSymbolicLink() && /[\\/]scripts[\\/][\w-]+\.mjs$/u.test(fs.readlinkSync(file));
  } catch {
    return false;
  }
}

function onPath(dir, env) {
  return String(env.PATH ?? env.Path ?? "").split(path.delimiter).some((p) => p && path.resolve(p) === path.resolve(dir));
}

/**
 * Link `name` to `scriptPath`. Returns { ok, path, onPath, reason? }; never throws.
 * An existing link to another copy of the plugin is replaced (the latest setup wins, as for `laya`).
 */
export function linkCommand(name, scriptPath, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const dir = binDir({ env, home });
  const target = path.join(dir, platform === "win32" ? `${name}.cmd` : name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch {}
    if (exists && !isOurs(target, platform)) return { ok: false, path: target, onPath: onPath(dir, env), reason: `${target} exists and is not the plugin's; left unchanged` };
    if (platform === "win32") {
      fs.writeFileSync(target, `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
    } else {
      try { fs.chmodSync(scriptPath, 0o755); } catch {}
      if (exists) fs.unlinkSync(target);
      fs.symlinkSync(scriptPath, target);
    }
    return { ok: true, path: target, onPath: onPath(dir, env) };
  } catch (error) {
    return { ok: false, path: target, onPath: false, reason: error.message };
  }
}

/** Remove `name` only when it points at `scriptPath`. */
export function unlinkCommand(name, scriptPath, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const dir = binDir({ env, home });
  const target = path.join(dir, platform === "win32" ? `${name}.cmd` : name);
  try {
    if (platform === "win32") {
      if (fs.readFileSync(target, "utf8").includes(scriptPath)) fs.unlinkSync(target);
    } else if (fs.lstatSync(target).isSymbolicLink() && path.resolve(dir, fs.readlinkSync(target)) === scriptPath) {
      fs.unlinkSync(target);
    }
  } catch {}
}

/** Link the `omem` command to this package's scripts/omem.mjs and say so on `output`. */
export function linkOmem(output = null, options = {}) {
  const env = options.env ?? process.env;
  // A package unpacked in the temp folder (a test or a one-off check) must not take over the user's
  // command: the link would break when the folder is cleaned. Only an explicit bin dir allows it.
  const tmp = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })();
  const script = (() => { try { return fs.realpathSync(omemScript()); } catch { return omemScript(); } })();
  if (!env.OBSIDIAN_MEMORY_BIN_DIR?.trim() && (script === tmp || script.startsWith(tmp + path.sep))) {
    if (output) output.write("Not linking the 'omem' command to a copy in the temporary folder.\n");
    return { ok: false, path: null, onPath: false, reason: "temporary copy" };
  }
  const r = linkCommand("omem", omemScript(), options);
  if (output) {
    if (r.ok) output.write(`Linked the 'omem' command (export, import, search, doctor …) at ${r.path}.${r.onPath ? "" : ` Add ${path.dirname(r.path)} to PATH to use it.`}\n`);
    else output.write(`Could not link the 'omem' command: ${r.reason}. Run the scripts with node instead.\n`);
  }
  return r;
}
