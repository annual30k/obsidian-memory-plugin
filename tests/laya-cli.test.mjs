import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runCli, isMain, parseArgs } from "../lib/memory-router/cli.js";

test("CLI tool parseArgs correctly parses arguments", () => {
  const parsed = parseArgs(["--stdin", "--project-id", "prj-123", "--mode", "auto"]);
  assert.equal(parsed.stdinMode, true);
  assert.equal(parsed.projectId, "prj-123");
  assert.equal(parsed.config.mode, "auto");
});

test("CLI tool without --stdin never touches stdin and exits cleanly", async () => {
  let output = "";
  const mockStdout = {
    write: (chunk) => { output += chunk; return true; }
  };
  let stdinRead = false;
  const mockStdin = new Readable({
    read() {
      stdinRead = true;
      this.push(null);
    }
  });

  const exitCode = await runCli(
    ["--text", "你好", "--mode", "manual", "--endpoint", "http://127.0.0.1:18791"],
    { stdin: mockStdin, stdout: mockStdout }
  );

  assert.equal(exitCode, 0);
  assert.equal(stdinRead, false, "stdin must not be read when --stdin is absent");
  const parsed = JSON.parse(output);
  assert.equal(parsed.recallRecommended, false);
  assert.equal(parsed.reason, "trivial_greeting");
});

test("CLI tool with --stdin reads plain text from Readable stream", async () => {
  let output = "";
  const mockStdout = {
    write: (chunk) => { output += chunk; return true; }
  };
  const mockStdin = Readable.from(["帮我回忆一下之前的踩坑记录"]);

  const exitCode = await runCli(
    ["--stdin", "--mode", "manual", "--endpoint", "http://127.0.0.1:18791"],
    { stdin: mockStdin, stdout: mockStdout }
  );

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.recallRecommended, true);
  assert.equal(parsed.reason, "explicit_recall_intent");
  assert.ok(parsed.guidanceAppend.includes("recall recommended"));
});

test("CLI tool with --stdin reads structured JSON from Readable stream", async () => {
  let output = "";
  const mockStdout = {
    write: (chunk) => { output += chunk; return true; }
  };
  const inputJson = JSON.stringify({
    text: "你好",
    projectId: "my-proj",
    config: { mode: "manual", endpoint: "http://127.0.0.1:18791" }
  });
  const mockStdin = Readable.from([inputJson]);

  const exitCode = await runCli(
    ["--stdin"],
    { stdin: mockStdin, stdout: mockStdout }
  );

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.recallRecommended, false);
  assert.equal(parsed.reason, "trivial_greeting");
});

test("CLI tool returns mode_off reason when mode is off", async () => {
  let output = "";
  const mockStdout = {
    write: (chunk) => { output += chunk; return true; }
  };

  const exitCode = await runCli(
    ["--text", "如何优化数据库查询？", "--mode", "off"],
    { stdout: mockStdout }
  );

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.recallRecommended, false);
  assert.equal(parsed.reason, "mode_off");
});

test("CLI tool isMain correctly detects entry file", () => {
  const currentFile = import.meta.url;
  const currentFilePath = fileURLToPath(currentFile);
  assert.equal(isMain(currentFile, currentFilePath), true);
  assert.equal(isMain(currentFile, "/other/path/index.js"), false);
  assert.equal(isMain(currentFile, null), false);
});

test("CLI tool isMain handles win32 path formats and case insensitivity", () => {
  assert.equal(isMain("file:///C:/project/lib/memory-router/cli.js", "C:\\project\\lib\\memory-router\\cli.js"), true);
  assert.equal(isMain("file:///C:/Project/lib/memory-router/cli.js", "c:\\project\\LIB\\memory-router\\cli.js"), true);
  assert.equal(isMain("file:///C:/project/lib/memory-router/cli.js", "C:\\project\\lib\\memory-router\\other.js"), false);
});

test("CLI smoke test via child_process spawn executes and outputs valid JSON", async () => {
  const cliPath = path.resolve("lib/memory-router/cli.js");
  const proc = spawn(process.execPath, [cliPath, "--stdin", "--mode", "manual", "--endpoint", "http://127.0.0.1:18791"]);

  let stdoutData = "";
  proc.stdout.on("data", (chunk) => { stdoutData += chunk; });

  const exitPromise = new Promise((resolve, reject) => {
    proc.on("close", resolve);
    proc.on("error", reject);
  });

  proc.stdin.write("你好");
  proc.stdin.end();

  const code = await exitPromise;
  assert.equal(code, 0);

  const parsed = JSON.parse(stdoutData);
  assert.equal(parsed.recallRecommended, false);
  assert.equal(parsed.reason, "trivial_greeting");
});

test("Package bin installed from npm pack tarball runs via symlink and exits naturally", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const { execSync } = await import("node:child_process");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-bin-pack-test-"));
  try {
    const packOut = execSync(`npm pack --ignore-scripts --pack-destination "${tmpDir}"`, { encoding: "utf8" }).trim();
    const tarball = packOut.split("\n").filter(Boolean).pop().trim();
    const tarballPath = path.join(tmpDir, tarball);

    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "consumer-test", version: "1.0.0" }));
    execSync(`npm install "${tarballPath}" --no-audit --no-fund`, { cwd: tmpDir, stdio: "ignore" });

    const binName = process.platform === "win32" ? "obsidian-memory-laya-judge.cmd" : "obsidian-memory-laya-judge";
    const binPath = path.join(tmpDir, "node_modules", ".bin", binName);
    assert.equal(fs.existsSync(binPath), true, "Package bin symlink must exist in node_modules/.bin");

    const proc = spawn(binPath, ["--stdin", "--mode", "off"], {
      shell: process.platform === "win32"
    });

    let stdoutData = "";
    proc.stdout.on("data", (chunk) => { stdoutData += chunk; });

    const exitPromise = new Promise((resolve, reject) => {
      proc.on("close", resolve);
      proc.on("error", reject);
    });

    proc.stdin.write("你好");
    proc.stdin.end();

    const code = await exitPromise;
    assert.equal(code, 0);

    const parsed = JSON.parse(stdoutData);
    assert.equal(parsed.recallRecommended, false);
    assert.equal(parsed.reason, "mode_off");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI flags take precedence over stdin JSON on conflict (explicit CLI > stdin JSON)", async () => {
  // Test 1: --mode off overrides stdin config mode: manual
  let output1 = "";
  const mockStdout1 = {
    write: (chunk) => { output1 += chunk; return true; }
  };
  const stdinJson1 = JSON.stringify({
    text: "复杂问题",
    config: { mode: "manual", endpoint: "http://127.0.0.1:18791" }
  });
  const mockStdin1 = Readable.from([stdinJson1]);

  const exitCode1 = await runCli(
    ["--stdin", "--mode", "off"],
    { stdin: mockStdin1, stdout: mockStdout1 }
  );

  assert.equal(exitCode1, 0);
  const parsed1 = JSON.parse(output1);
  assert.equal(parsed1.recallRecommended, false);
  assert.equal(parsed1.reason, "mode_off", "Explicit CLI --mode off must take precedence over stdin config.mode");

  // Test 2: --text CLI flag overrides stdin JSON text
  let output2 = "";
  const mockStdout2 = {
    write: (chunk) => { output2 += chunk; return true; }
  };
  const stdinJson2 = JSON.stringify({
    text: "你好",
    config: { mode: "off" }
  });
  const mockStdin2 = Readable.from([stdinJson2]);

  const exitCode2 = await runCli(
    ["--stdin", "--text", "帮我回忆一下之前的踩坑记录", "--mode", "off"],
    { stdin: mockStdin2, stdout: mockStdout2 }
  );

  assert.equal(exitCode2, 0);
  const parsed2 = JSON.parse(output2);
  // With mode off it will return mode_off, but let's test with explicit recall to verify text was overridden
  // When text is "帮我回忆..." fast-path returns explicit_recall_intent before checking mode? Wait!
  // Fast path:
  // In MemoryRouter.evaluateRecall:
  // 1. Mode OFF -> reason: "mode_off".
  // Let's test with mode manual and fast-path text:
  let output3 = "";
  const mockStdout3 = {
    write: (chunk) => { output3 += chunk; return true; }
  };
  const stdinJson3 = JSON.stringify({
    text: "复杂问题", // Would need Laya client
    projectId: "stdin-proj"
  });
  const mockStdin3 = Readable.from([stdinJson3]);

  const exitCode3 = await runCli(
    ["--stdin", "--text", "你好", "--project-id", "cli-proj", "--mode", "manual", "--endpoint", "http://127.0.0.1:18791"],
    { stdin: mockStdin3, stdout: mockStdout3 }
  );

  assert.equal(exitCode3, 0);
  const parsed3 = JSON.parse(output3);
  // "你好" is trivial greeting and fast-paths without calling endpoint!
  assert.equal(parsed3.reason, "trivial_greeting", "Explicit CLI --text '你好' must override stdin text '复杂问题'");
});

test("CLI tool outputs proactive capture recommendation on explicit remember directive", async () => {
  let output = "";
  const mockStdout = {
    write: (chunk) => { output += chunk; return true; }
  };
  const mockStdin = Readable.from(["记住这个：我们在 macOS 必须用 /shutdown 停机，不要直接杀 PID"]);

  const exitCode = await runCli(
    ["--stdin", "--mode", "manual", "--endpoint", "http://127.0.0.1:18791"],
    { stdin: mockStdin, stdout: mockStdout }
  );

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.recallRecommended, false);
  assert.equal(parsed.captureRecommended, true);
  assert.equal(parsed.captureCategory, "decision");
  assert.ok(parsed.guidanceAppend.includes("high-value decision detected"));
  assert.ok(parsed.guidanceAppend.includes("pending-ingest"));
});


