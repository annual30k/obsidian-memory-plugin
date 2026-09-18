import { spawnSync } from "node:child_process";

export function findPython() {
  const candidates = [
    ...(process.env.PYTHON ? [{ command: process.env.PYTHON, args: [] }] : []),
    ...(process.platform === "win32"
      ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }]
      : [{ command: "python3", args: [] }, { command: "python", args: [] }])
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, "-c", "import sys; print(sys.version_info.major)"], {
      encoding: "utf8", timeout: 5000, windowsHide: true
    });
    if (result.status === 0 && result.stdout.trim() === "3") return candidate;
  }
  throw new Error("Python 3 is required (set PYTHON or install the python/py launcher)");
}
