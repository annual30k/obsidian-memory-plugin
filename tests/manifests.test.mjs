import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setVersion, JSON_MANIFESTS } from "../scripts/set-version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("every host manifest declares the same plugin version and name", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const file of JSON_MANIFESTS) {
    assert.equal(JSON.parse(read(file)).version, pkg.version, `${file} version`);
  }
  assert.match(read("plugin.yaml"), new RegExp(`^version: ${pkg.version.replaceAll(".", "\\.")}$`, "mu"), "plugin.yaml version");
  assert.match(read("README.md"), new RegExp(`当前包版本：\`${pkg.version.replaceAll(".", "\\.")}\``, "u"), "README version");
  for (const file of ["openclaw.plugin.json", "plugin.json"]) assert.equal(JSON.parse(read(file)).id ?? JSON.parse(read(file)).name, pkg.name, `${file} id/name`);
  assert.match(read("plugin.yaml"), new RegExp(`^name: ${pkg.name}$`, "mu"));
});

test("version:set rewrites every manifest and the README in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-version-"));
  for (const file of [...JSON_MANIFESTS, "plugin.yaml", "README.md"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const changed = setVersion("9.8.7", dir);
  assert.equal(changed.length, 6);
  for (const file of JSON_MANIFESTS) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).version, "9.8.7", file);
  assert.match(fs.readFileSync(path.join(dir, "plugin.yaml"), "utf8"), /^version: 9\.8\.7$/mu);
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /当前包版本：`9\.8\.7`/u);
  assert.throws(() => setVersion("v1", dir), /semantic version/u);
});

test("the always-on rule has one source and the docs quote it verbatim", async () => {
  const { TRIGGER_INSTRUCTION } = await import("../lib/managed-block.js");
  assert.equal(TRIGGER_INSTRUCTION, JSON.parse(read("lib/guidance.json")).trigger);
  assert.ok(read("README.md").includes(TRIGGER_INSTRUCTION), "README quotes the rule");
  assert.ok(read("examples/antigravity.gemini.md").includes(TRIGGER_INSTRUCTION), "example quotes the rule");
  assert.ok(!/TRIGGER_INSTRUCTION = \(/u.test(read("__init__.py")), "Hermes reads lib/guidance.json instead of a copy");
});

test("every `laya <tool>` subcommand forwards to an existing script that npm run also exposes", async () => {
  const { TOOL_COMMANDS } = await import("../scripts/laya-service.mjs");
  const scripts = JSON.parse(read("package.json")).scripts;
  for (const [name, file] of Object.entries(TOOL_COMMANDS)) {
    assert.ok(fs.existsSync(path.join(root, "scripts", file)), `${name} -> scripts/${file}`);
    assert.ok(Object.values(scripts).some((cmd) => cmd.includes(`scripts/${file}`)), `npm script for ${file}`);
  }
});
