import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findPython } from "./python.mjs";

const python = findPython();
const source = fileURLToPath(new URL("../__init__.py", import.meta.url));
execFileSync(python.command, [
  ...python.args, "-c",
  "import pathlib, sys; source = pathlib.Path(sys.argv[1]); compile(source.read_bytes(), str(source), 'exec')",
  source
], { stdio: "inherit" });
