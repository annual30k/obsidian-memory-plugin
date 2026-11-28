import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCommand, npmShimTarget } from "../lib/find-command.js";
import { resolveCodexCommand, resolveHermesCommand, resolveExtractor, runHermesExtraction } from "../lib/memory-router/llm-extract.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "om-findcmd-")));
const put = (file, text, mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode }); return file; };
// What `npm install -g` writes on Windows for a package bin.
const shim = (script) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\${script}" %*\r\n`;

test("Windows: an npm .cmd shim is started through Node with the script it wraps, .exe is preferred, the sh twin is ignored", () => {
  const dir = tmp();
  const script = put(path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  put(path.join(dir, "codex.cmd"), shim("node_modules\\@openai\\codex\\bin\\codex.js"));
  put(path.join(dir, "codex"), "#!/bin/sh\n", 0o755);
  assert.equal(npmShimTarget(path.join(dir, "codex.cmd")), script);
  const viaShim = findCommand("codex", { platform: "win32", dirs: [dir], nodePath: "NODE" });
  assert.deepEqual([viaShim.command, viaShim.args], ["NODE", [script]]);
  put(path.join(dir, "codex.exe"), "MZ");
  assert.equal(findCommand("codex", { platform: "win32", dirs: [dir] }).command, path.join(dir, "codex.exe"));
  assert.equal(findCommand("codex", { platform: "win32", dirs: [tmp()] }), null);
  put(path.join(dir, "odd.cmd"), "@echo off\r\nsomething.exe %*\r\n");
  assert.equal(findCommand("odd", { platform: "win32", dirs: [dir] }), null, "a .cmd that is not an npm shim is not run through cmd.exe");
});

test("Codex is found on PATH on Linux and Windows; on macOS only the app, as before, or CODEX_BIN", () => {
  const dir = tmp();
  const codex = put(path.join(dir, "codex"), "#!/bin/sh\n", 0o755);
  assert.equal(resolveCodexCommand({ PATH: dir }, { platform: "linux" }).command, codex);
  assert.equal(resolveCodexCommand({ PATH: dir }, { platform: "darwin" })?.file ?? null, fs.existsSync("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex") ? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" : null);
  assert.equal(resolveCodexCommand({ PATH: "", CODEX_BIN: codex }, { platform: "darwin" }).command, codex);
  const win = tmp();
  const script = put(path.join(win, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  put(path.join(win, "codex.cmd"), shim("node_modules\\@openai\\codex\\bin\\codex.js"));
  assert.deepEqual(resolveCodexCommand({ PATH: win }, { platform: "win32" }).args, [script]);
  // The digest then uses it once Codex is logged in.
  const codexHome = tmp();
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
  if (process.platform !== "darwin") assert.equal(resolveExtractor({ env: { PATH: dir, HOME: dir }, codexHome })?.name, "codex");
});

test("Hermes installed by npm on Windows is found and its one-shot call runs through Node", async () => {
  const dir = tmp();
  put(path.join(dir, "node_modules", "hermes", "cli.js"), 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));\n');
  put(path.join(dir, "hermes.cmd"), shim("node_modules\\hermes\\cli.js"));
  const cmd = resolveHermesCommand({ PATH: dir, HOME: tmp() }, { platform: "win32" });
  assert.ok(cmd && cmd.command === process.execPath);
  const out = JSON.parse(await runHermesExtraction("a prompt with \"quotes\" & %PATH% in it", { hermesCommand: cmd }));
  assert.deepEqual(out.args, ["-z", "a prompt with \"quotes\" & %PATH% in it", "--ignore-rules"], "the prompt reaches Hermes untouched, no cmd.exe in between");
});
