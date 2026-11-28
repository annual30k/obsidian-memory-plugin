/**
 * Find a command-line program the way a shell would, on every platform, and say how to start it without a
 * shell.
 *
 * On Windows a program is `<name>.exe` or, when npm installed it, a `<name>.cmd` shim. Node cannot spawn a
 * .cmd without a shell, and going through cmd.exe would expose the arguments (a whole prompt, for
 * `hermes -z`) to its quoting rules. So for an npm shim we start the JavaScript entry point it wraps with
 * this Node instead. Returns { command, args } (args go before the program's own), or null.
 */
import fs from "node:fs";
import path from "node:path";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** The script an npm .cmd shim runs (`"%dp0%\node_modules\…\bin\x.js" %*`), or null. */
export function npmShimTarget(shimPath) {
  let text = "";
  try { text = fs.readFileSync(shimPath, "utf8"); } catch { return null; }
  const m = /"%~?dp0%?\\([^"%]+\.(?:c|m)?js)"/iu.exec(text);
  if (!m) return null;
  const target = path.join(path.dirname(shimPath), ...m[1].split("\\"));
  return isFile(target) ? target : null;
}

/** How to run the program file `file`: { command, args } or null (a shim we cannot read). */
export function commandFor(file, { platform = process.platform, nodePath = process.execPath } = {}) {
  if (!isFile(file)) return null;
  if (platform === "win32" && /\.(cmd|bat)$/iu.test(file)) {
    const target = npmShimTarget(file);
    return target ? { command: nodePath, args: [target] } : null;
  }
  if (platform === "win32" && /\.ps1$/iu.test(file)) return null;
  return { command: file, args: [] };
}

/** Program `name` in `dirs` (default: PATH), as { command, args, file }, or null. */
export function findCommand(name, { env = process.env, platform = process.platform, dirs = null, nodePath = process.execPath } = {}) {
  const pathDirs = dirs ?? String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  // Not the bare name on Windows: npm puts a POSIX sh script there next to the .cmd.
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const dir of pathDirs) {
    for (const n of names) {
      const file = path.join(dir, n);
      const cmd = commandFor(file, { platform, nodePath });
      if (cmd) return { ...cmd, file };
    }
  }
  return null;
}
