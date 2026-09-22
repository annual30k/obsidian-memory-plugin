import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findPython } from "./python.mjs";

const python = findPython();
const filesToCheck = [
  fileURLToPath(new URL("../__init__.py", import.meta.url)),
  fileURLToPath(new URL("../lib/laya-service/service.py", import.meta.url))
];

for (const source of filesToCheck) {
  execFileSync(python.command, [
    ...python.args, "-c",
    "import pathlib, sys; source = pathlib.Path(sys.argv[1]); compile(source.read_bytes(), str(source), 'exec')",
    source
  ], { stdio: "inherit" });
}
