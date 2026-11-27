// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  addToProjectList, appendProjectEntry, filterProjectsYaml, gitRemotes, normalizeRemote, parseProjectsYaml, resolveProject
} from "../lib/vault-transfer/projects.js";
import { backfillRemotes, bindProject } from "../lib/vault-transfer/project-ops.js";
import { createTarGz, decryptBundle, encryptBundle, isEncrypted, readTarGz, unsafeEntryReason } from "../lib/vault-transfer/archive.js";
import { buildExport, collectVaultFiles, scanSecrets } from "../lib/vault-transfer/export.js";
import { applyImport, mergeLog, mergeProjects, planImport } from "../lib/vault-transfer/import.js";
import { resolveProjectIdFromCwd } from "../lib/memory-router/vault-index.js";
import { main as exportMain } from "../scripts/export-vault.mjs";
import { main as importMain } from "../scripts/import-vault.mjs";
import { main as projectsMain } from "../scripts/projects-vault.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, "utf8");
const sink = () => { let s = ""; return { write: (x) => { s += x; }, get text() { return s; } }; };

/** A Git checkout as far as the plugin can tell: .git/config with an origin. */
function fakeRepo(dir, origin, extra = "") {
  write(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n${extra}`);
  return dir;
}

function makeVault(root, { projects = [] } = {}) {
  const lines = ["# header comment", "projects:"];
  for (const p of projects) {
    lines.push(`  - id: ${p.id}`, "    roots:", ...p.roots.map((r) => `      - "${r}"`));
    if (p.remotes) lines.push("    remotes:", ...p.remotes.map((r) => `      - ${r}`));
    lines.push("    scope: private");
  }
  write(path.join(root, "00-System", "projects.yaml"), lines.join("\n") + "\n");
  write(path.join(root, "AGENTS.md"), "# Vault\n");
  write(path.join(root, "10-Global", "preferences.md"), "---\ntitle: Preferences\n---\n\n- 中文回复\n");
  write(path.join(root, "10-Global", "log.md"), "# Global Log\n\n## [2026-09-01] ingest | first\n\n- a\n");
  for (const p of projects) {
    write(path.join(root, "20-Projects", p.id, "AGENTS.md"), `# ${p.id}\n`);
    write(path.join(root, "20-Projects", p.id, "log.md"), `# Log\n\n\`\`\`markdown\n## [YYYY-MM-DD] operation | title\n\`\`\`\n\n## [2026-09-02] ingest | one\n\n- Relation: new concept\n`);
    write(path.join(root, "20-Projects", p.id, "wiki", "knowledge", "note.md"), "---\ntitle: Note\n---\n\nbody\n");
  }
  return root;
}

// ---------------------------------------------------------------- projects.yaml + remotes

test("normalizeRemote gives one identity for ssh, https and scp forms and ignores local remotes", () => {
  for (const u of ["git@github.com:Owner/Repo.git", "https://github.com/owner/repo", "https://user:tok@github.com/owner/repo.git/", "ssh://git@github.com:22/owner/repo.git"]) {
    assert.equal(normalizeRemote(u), "github.com/owner/repo", u);
  }
  assert.equal(normalizeRemote("ssh://git@nas.local:2222/team/memory.git"), "nas.local/team/memory");
  for (const u of ["/srv/git/repo.git", "./repo", "file:///srv/repo", "C:\\repos\\x", "", null]) assert.equal(normalizeRemote(u), null, String(u));
});

test("gitRemotes reads origin without running git, follows a worktree's .git file, and ignores a fork's upstream", () => {
  const base = tmp("om-git-");
  const repo = fakeRepo(path.join(base, "repo"), "git@github.com:me/app.git", `[remote "upstream"]\n\turl = https://github.com/them/app\n`);
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  assert.deepEqual(gitRemotes(path.join(repo, "src", "deep")), { root: repo, remotes: ["github.com/me/app"] });
  // A linked worktree: .git is a file pointing into the main repo's worktrees/<name>, with a commondir.
  const wtGit = path.join(repo, ".git", "worktrees", "wt");
  write(path.join(wtGit, "commondir"), "../..\n");
  const wt = path.join(base, "wt");
  write(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
  assert.deepEqual(gitRemotes(wt).remotes, ["github.com/me/app"]);
  // Only an upstream remote (no origin, several remotes) is not an identity.
  const fork = path.join(base, "fork");
  write(path.join(fork, ".git", "config"), `[remote "a"]\n\turl = https://h/x/a\n[remote "b"]\n\turl = https://h/x/b\n`);
  assert.deepEqual(gitRemotes(fork).remotes, []);
  fs.rmSync(base, { recursive: true, force: true });
});

test("a checkout at a new path resolves to its project by remote; roots still win; a shared remote resolves to nothing", () => {
  const base = tmp("om-resolve-");
  const here = fakeRepo(path.join(base, "elsewhere", "app"), "https://github.com/me/app.git");
  const projects = parseProjectsYaml([
    "projects:",
    "  - id: app-11111111", "    roots:", "      - /Users/other-machine/code/app", "    remotes:", "      - github.com/me/app", "    scope: private",
    "  - id: local-22222222", "    roots:", `      - ${path.join(base, "elsewhere", "app", "pkg")}`, "    scope: private"
  ].join("\n"));
  assert.deepEqual(resolveProject(projects, here), { id: "app-11111111", via: "remote", gitRoot: here, remote: "github.com/me/app" });
  fs.mkdirSync(path.join(here, "pkg"));
  assert.equal(resolveProject(projects, path.join(here, "pkg")).id, "local-22222222", "a registered root beats the remote");
  const shared = parseProjectsYaml("projects:\n  - id: a\n    remotes: [github.com/me/app]\n  - id: b\n    remotes: [github.com/me/app]\n");
  assert.equal(resolveProject(shared, here), null);
  // The router's resolver uses the same rule.
  const vault = makeVault(path.join(base, "vault"), { projects: [{ id: "app-11111111", roots: ["/Users/other-machine/code/app"], remotes: ["github.com/me/app"] }] });
  assert.equal(resolveProjectIdFromCwd(vault, path.join(here, "pkg")), "app-11111111");
  fs.rmSync(base, { recursive: true, force: true });
});

test("projects.yaml edits only add list items and keep comments, quoting and other keys", () => {
  const text = [
    "# keep me", "projects:",
    "  - id: a-1", "    roots:", "      - \"/Users/me/碎了个碗/a\"", "    scope: private", "    note: keep",
    "  - id: b-2", "    roots: []", "    scope: private"
  ].join("\n") + "\n";
  let next = addToProjectList(text, "a-1", "roots", ["C:\\Users\\me\\a", "/Users/me/碎了个碗/a"]);
  next = addToProjectList(next, "a-1", "remotes", ["github.com/me/a"]);
  next = addToProjectList(next, "b-2", "roots", ["/srv/b"]);
  assert.match(next, /^# keep me$/mu);
  assert.match(next, /    note: keep/u);
  const parsed = parseProjectsYaml(next);
  assert.deepEqual(parsed[0].roots, ["/Users/me/碎了个碗/a", "C:\\Users\\me\\a"]);
  assert.deepEqual(parsed[0].remotes, ["github.com/me/a"]);
  assert.deepEqual(parsed[1].roots, ["/srv/b"]);
  assert.equal(addToProjectList(next, "a-1", "remotes", ["GITHUB.com/me/a"]), next, "remotes compare case-insensitively");
  assert.throws(() => addToProjectList(text, "missing", "roots", ["/x"]), /not in projects.yaml/u);
  const appended = appendProjectEntry(next, { id: "c-3", roots: [], remotes: ["h/c"], scope: "private" });
  assert.deepEqual(parseProjectsYaml(appended).map((p) => p.id), ["a-1", "b-2", "c-3"]);
  assert.deepEqual(parseProjectsYaml(filterProjectsYaml(appended, ["b-2"])).map((p) => p.id), ["b-2"]);
});

test("omem projects bind adds this machine's checkout; backfill-remotes records remotes; both are dry runs without --yes", () => {
  const base = tmp("om-bind-");
  const repo = fakeRepo(path.join(base, "code", "app"), "git@github.com:me/app.git");
  const vault = makeVault(path.join(base, "vault"), { projects: [{ id: "app-1", roots: ["/old/machine/app"] }, { id: "other-2", roots: [repo] }] });
  const before = read(path.join(vault, "00-System", "projects.yaml"));
  // other-2 already owns the directory by root.
  assert.match(bindProject(vault, "app-1", repo).error, /already belongs to project other-2/u);

  const vault2 = makeVault(path.join(base, "vault2"), { projects: [{ id: "app-1", roots: ["/old/machine/app"] }] });
  const out = sink();
  assert.equal(projectsMain(["bind", "app-1", path.join(repo), "--vault", vault2], out, sink()), 0);
  assert.match(out.text, /Would add root/u);
  assert.equal(projectsMain(["bind", "app-1", repo, "--vault", vault2, "--yes"], sink(), sink()), 0);
  const p = parseProjectsYaml(read(path.join(vault2, "00-System", "projects.yaml")))[0];
  assert.deepEqual(p.roots, ["/old/machine/app", repo]);
  assert.deepEqual(p.remotes, ["github.com/me/app"]);

  const r = backfillRemotes(vault);
  assert.deepEqual(r.changes, [{ id: "other-2", add: ["github.com/me/app"] }]);
  assert.equal(read(path.join(vault, "00-System", "projects.yaml")), before, "dry run writes nothing");
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- archive

test("tar.gz round-trips long non-ASCII names and is readable by a plain tar layout; encryption needs the passphrase", () => {
  const long = `20-Projects/集团信创OA-c9a48417/wiki/${"很长的名字".repeat(20)}.md`;
  const gz = createTarGz([{ name: "a.md", data: Buffer.from("hi") }, { name: long, data: Buffer.from("长") }]);
  const { files, rejected } = readTarGz(gz);
  assert.deepEqual(files.map((f) => [f.name, f.data.toString()]), [["a.md", "hi"], [long, "长"]]);
  assert.deepEqual(rejected, []);
  const enc = encryptBundle(gz, "correct horse");
  assert.ok(isEncrypted(enc));
  assert.ok(decryptBundle(enc, "correct horse").equals(gz));
  assert.throws(() => decryptBundle(enc, "wrong horse"), /wrong passphrase/u);
  assert.throws(() => decryptBundle(enc, null), /passphrase is required/u);
  assert.throws(() => encryptBundle(gz, "short"), /at least 8/u);
});

test("unsafe member names, links and devices are rejected, never extracted", () => {
  for (const n of ["../x", "a/../../b", "/etc/passwd", "C:/x", "a\\b", "CON", "a/nul.txt", "dir/x.", "a:b", "a//b"]) {
    assert.ok(unsafeEntryReason(n), n);
  }
  assert.equal(unsafeEntryReason("20-Projects/下班了-1485a4ab/log.md"), null);
  // Hand-build a tar with a traversal name and a symlink: neither comes back as a file.
  const header = (name, type, size = 0, link = "") => {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.write("        ", 148);
    h.write(type, 156); h.write(link, 157); h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const body = Buffer.alloc(512); body.write("evil");
  const tar = Buffer.concat([header("../evil.md", "0", 4), body, header("link.md", "2", 0, "/etc/passwd"), Buffer.alloc(1024)]);
  const { files, rejected } = readTarGz(zlib.gzipSync(tar));
  assert.equal(files.length, 0);
  assert.deepEqual(rejected.map((r) => r.name), ["../evil.md", "link.md"]);
});

// ---------------------------------------------------------------- export

test("export leaves out machine-local and other tools' files, records remotes in the bundle only, and flags credentials", () => {
  const base = tmp("om-export-");
  const repo = fakeRepo(path.join(base, "code", "app"), "https://github.com/me/app.git");
  const vault = makeVault(path.join(base, "vault"), { projects: [{ id: "app-1", roots: [repo] }, { id: "b-2", roots: [] }] });
  write(path.join(vault, ".obsidian", "workspace.json"), "{}");
  write(path.join(vault, ".obsidian", "app.json"), "{}");
  write(path.join(vault, ".claude", "settings.local.json"), "{}");
  write(path.join(vault, ".DS_Store"), "x");
  write(path.join(vault, "10-Global", "raw", "secret.md"), "api_key = abcdefghijklmnopqrstuvwxyz\n");
  // Windows needs a privilege for symlinks; the junction-free case is covered on macOS/Linux.
  const linked = process.platform !== "win32";
  if (linked) fs.symlinkSync(path.join(base, "code"), path.join(vault, "30-link"));
  const layaDir = path.join(base, "laya");
  write(path.join(layaDir, "labels.jsonl"), "{\"t\":1}\n");
  write(path.join(layaDir, "recall-head.json"), "{\"w\":[1]}");
  write(path.join(layaDir, "decisions.jsonl"), "{\"p\":\"private\"}\n");
  write(path.join(layaDir, "service.json"), "{}");
  write(path.join(layaDir, "cache", "vault-index.json"), "{}");
  const registryBefore = read(path.join(vault, "00-System", "projects.yaml"));

  const r = buildExport(vault, { layaDir });
  const names = r.manifest.files.map((f) => f.path);
  assert.ok(names.includes("vault/10-Global/preferences.md"));
  assert.ok(!names.some((n) => n.includes(".obsidian") || n.includes(".claude") || n.includes(".DS_Store") || n.includes("30-link")));
  assert.deepEqual(names.filter((n) => n.startsWith("laya/")).sort(), ["laya/labels.jsonl", "laya/recall-head.json"]);
  assert.deepEqual(r.skipped.map((s) => s.rel).sort(), linked ? [".claude", "30-link"] : [".claude"]);
  assert.deepEqual(r.secrets.map((s) => [s.rel, s.line]), [["vault/10-Global/raw/secret.md", 1]]);
  assert.deepEqual(r.manifest.projects.find((p) => p.id === "app-1").remotes, ["github.com/me/app"]);
  assert.equal(read(path.join(vault, "00-System", "projects.yaml")), registryBefore, "the Vault is not changed");

  const withConfig = buildExport(vault, { layaDir, withObsidianConfig: true, withDecisions: true }).manifest.files.map((f) => f.path);
  assert.ok(withConfig.includes("vault/.obsidian/app.json") && !withConfig.includes("vault/.obsidian/workspace.json"));
  assert.ok(withConfig.includes("laya/decisions.jsonl"));

  const partial = buildExport(vault, { layaDir, projects: ["b-2"], withGlobal: false });
  const pn = partial.manifest.files.map((f) => f.path);
  assert.ok(!pn.some((n) => n.startsWith("vault/20-Projects/app-1") || n.startsWith("vault/10-Global") || n.startsWith("laya/")));
  assert.deepEqual(partial.manifest.projects.map((p) => p.id), ["b-2"]);
  assert.throws(() => buildExport(vault, { layaDir, projects: ["nope"] }), /unknown project/u);
  assert.throws(() => buildExport(base, { layaDir }), /does not look like/u);
  assert.deepEqual(scanSecrets("a.md", Buffer.from("token: ${TOKEN}\npassword: <your-password>\n")), []);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- import

test("import into an empty folder reproduces the Vault; importing again changes nothing", () => {
  const base = tmp("om-import-");
  const vault = makeVault(path.join(base, "vault"), { projects: [{ id: "app-1", roots: ["/elsewhere/app"], remotes: ["github.com/me/app"] }] });
  const layaDir = path.join(base, "laya");
  write(path.join(layaDir, "labels.jsonl"), "{\"t\":1}\n");
  const { bundle } = buildExport(vault, { layaDir });
  const target = path.join(base, "new");
  const targetLaya = path.join(base, "laya2");
  const plan = planImport(bundle, { targetVault: target, layaDir: targetLaya });
  assert.equal(plan.target.state, "missing");
  assert.ok(!fs.existsSync(target), "planning writes nothing");
  assert.deepEqual(plan.projects.map((p) => [p.id, p.status]), [["app-1", "by-remote"]]);
  applyImport(plan);
  for (const rel of ["AGENTS.md", "10-Global/log.md", "20-Projects/app-1/wiki/knowledge/note.md", "00-System/projects.yaml"]) {
    assert.equal(read(path.join(target, rel)), read(path.join(vault, rel)), rel);
  }
  assert.equal(read(path.join(targetLaya, "labels.jsonl")), "{\"t\":1}\n");
  const again = planImport(bundle, { targetVault: target, layaDir: targetLaya });
  assert.equal(again.writes.length, 0);
  assert.equal(again.target.state, "vault");
  // A non-empty folder that is not a Vault is refused.
  write(path.join(base, "other", "x.txt"), "x");
  assert.throws(() => planImport(bundle, { targetVault: path.join(base, "other"), layaDir: targetLaya }), /not an Obsidian Memory Vault/u);
  fs.rmSync(base, { recursive: true, force: true });
});

test("merging into a diverged Vault keeps local notes, appends missing log entries and parks conflicting copies", () => {
  const base = tmp("om-merge-");
  const a = makeVault(path.join(base, "a"), { projects: [{ id: "app-1", roots: ["/machine-a/app"], remotes: ["github.com/me/app"] }, { id: "only-a-3", roots: [] }] });
  const b = makeVault(path.join(base, "b"), { projects: [{ id: "app-1", roots: ["/machine-b/app"] }] });
  // Both machines worked: A has a new log entry and edited the note; B has its own entry.
  fs.appendFileSync(path.join(a, "20-Projects", "app-1", "log.md"), "\n## [2026-10-01] ingest | from A\n\n- Relation: new concept\n");
  fs.appendFileSync(path.join(b, "20-Projects", "app-1", "log.md"), "\n## [2026-10-02] ingest | from B\n\n- Relation: new concept\n");
  write(path.join(a, "20-Projects", "app-1", "wiki", "knowledge", "note.md"), "---\ntitle: Note\n---\n\nbody edited on A\n");
  write(path.join(a, "20-Projects", "app-1", "wiki", "knowledge", "new.md"), "new on A\n");
  write(path.join(b, ".obsidian", "app.json"), "{\"b\":1}");
  const layaA = path.join(base, "laya-a");
  const layaB = path.join(base, "laya-b");
  write(path.join(layaA, "labels.jsonl"), "{\"t\":1}\n{\"t\":2}\n");
  write(path.join(layaA, "recall-head.json"), "{\"w\":\"A\"}");
  write(path.join(layaB, "labels.jsonl"), "{\"t\":1}\n{\"t\":3}\n");
  write(path.join(layaB, "recall-head.json"), "{\"w\":\"B\"}");
  const { bundle } = buildExport(a, { layaDir: layaA, withObsidianConfig: true });
  write(path.join(a, ".obsidian", "app.json"), "{\"a\":1}");

  const now = new Date(2026, 10, 27, 9, 30, 0);
  const plan = planImport(bundle, { targetVault: b, layaDir: layaB, now });
  assert.deepEqual(plan.vault.add.sort(), ["20-Projects/app-1/wiki/knowledge/new.md", "20-Projects/only-a-3/AGENTS.md", "20-Projects/only-a-3/log.md", "20-Projects/only-a-3/wiki/knowledge/note.md"]);
  assert.deepEqual(plan.vault.merged, [{ rel: "20-Projects/app-1/log.md", added: 1 }]);
  assert.deepEqual(plan.vault.conflicts, [{ rel: "20-Projects/app-1/wiki/knowledge/note.md", copy: "00-System/import-conflicts/20261127-093000/20-Projects/app-1/wiki/knowledge/note.md" }]);
  applyImport(plan);

  const log = read(path.join(b, "20-Projects", "app-1", "log.md"));
  assert.ok(log.indexOf("from B") < log.indexOf("from A"), "local entries first, then the imported ones");
  assert.equal(log.match(/## \[2026-09-02\] ingest \| one/gu).length, 1, "shared entries are not duplicated");
  assert.equal(log.match(/YYYY-MM-DD/gu).length, 1, "headings inside code fences are not entries");
  assert.equal(read(path.join(b, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), "---\ntitle: Note\n---\n\nbody\n", "local note kept");
  assert.match(read(path.join(b, plan.conflictsDir, "20-Projects", "app-1", "wiki", "knowledge", "note.md")), /edited on A/u);
  assert.match(read(path.join(b, plan.conflictsDir, "README.md")), /\[\[20-Projects\/app-1\/wiki\/knowledge\/note\]\]/u);
  assert.equal(read(path.join(b, ".obsidian", "app.json")), "{\"b\":1}", ".obsidian is never overwritten");

  const registry = parseProjectsYaml(read(path.join(b, "00-System", "projects.yaml")));
  assert.deepEqual(registry.map((p) => p.id), ["app-1", "only-a-3"]);
  assert.deepEqual(registry[0].roots, ["/machine-b/app", "/machine-a/app"]);
  assert.deepEqual(registry[0].remotes, ["github.com/me/app"]);

  assert.equal(read(path.join(layaB, "labels.jsonl")), "{\"t\":1}\n{\"t\":3}\n{\"t\":2}\n");
  assert.equal(read(path.join(layaB, "recall-head.json")), "{\"w\":\"B\"}", "a local head is kept unless replaceHeads");
  assert.deepEqual(plan.laya.keptLocal, ["recall-head.json"]);
  const replaced = planImport(bundle, { targetVault: b, layaDir: layaB, replaceHeads: true, now });
  applyImport(replaced);
  assert.equal(read(path.join(layaB, "recall-head.json")), "{\"w\":\"A\"}");
  fs.rmSync(base, { recursive: true, force: true });
});

test("--map binds a project to this machine's checkout; a remote owned by another local project is not copied", () => {
  const base = tmp("om-map-");
  const src = makeVault(path.join(base, "src"), { projects: [{ id: "app-1", roots: ["/machine-a/app"] }, { id: "dup-a", roots: ["/machine-a/dup"], remotes: ["github.com/me/dup"] }] });
  const dst = makeVault(path.join(base, "dst"), { projects: [{ id: "dup-b", roots: ["/machine-b/dup"], remotes: ["github.com/me/dup"] }] });
  const repo = fakeRepo(path.join(base, "code", "app"), "git@github.com:me/app.git");
  fs.mkdirSync(path.join(repo, "sub"));
  const { bundle } = buildExport(src, { layaDir: path.join(base, "none") });
  const plan = planImport(bundle, { targetVault: dst, layaDir: path.join(base, "none"), maps: { "app-1": path.join(repo, "sub") } });
  assert.deepEqual(plan.projectChanges.skipped, [{ id: "dup-a", remote: "github.com/me/dup", reason: "already recorded for dup-b" }]);
  assert.equal(plan.projects.find((p) => p.id === "app-1").status, "mapped");
  applyImport(plan);
  const app = parseProjectsYaml(read(path.join(dst, "00-System", "projects.yaml"))).find((p) => p.id === "app-1");
  assert.deepEqual(app.roots, ["/machine-a/app", repo], "the Git root, not the subdirectory");
  assert.deepEqual(app.remotes, ["github.com/me/app"]);
  assert.equal(resolveProjectIdFromCwd(dst, path.join(repo, "sub")), "app-1");
  fs.rmSync(base, { recursive: true, force: true });
});

test("empty folders (inbox/assets, checkpoints, 30-Shared) survive export and import", () => {
  const base = tmp("om-dirs-");
  const vault = makeVault(path.join(base, "vault"), { projects: [{ id: "app-1", roots: [] }] });
  for (const d of ["30-Shared", "10-Global/inbox/assets", "20-Projects/app-1/checkpoints", "20-Projects/app-1/inbox/assets", "20-Projects/app-1/wiki/pitfalls", "中文/空目录"]) {
    fs.mkdirSync(path.join(vault, ...d.split("/")), { recursive: true });
  }
  const { bundle, manifest } = buildExport(vault, { layaDir: path.join(base, "none") });
  assert.ok(manifest.dirs.includes("vault/20-Projects/app-1/inbox/assets"));
  assert.ok(readTarGz(bundle).dirs.includes("vault/中文/空目录"), "directories are also tar entries");
  const target = path.join(base, "new");
  const plan = planImport(bundle, { targetVault: target, layaDir: path.join(base, "none") });
  applyImport(plan);
  for (const d of ["30-Shared", "10-Global/inbox/assets", "20-Projects/app-1/checkpoints", "20-Projects/app-1/inbox/assets", "20-Projects/app-1/wiki/pitfalls", "中文/空目录"]) {
    assert.ok(fs.statSync(path.join(target, ...d.split("/"))).isDirectory(), d);
  }
  // Into an existing Vault only the missing folders are created; a file in the way is left alone.
  fs.rmSync(path.join(target, "20-Projects", "app-1", "checkpoints"), { recursive: true });
  fs.rmSync(path.join(target, "30-Shared"), { recursive: true });
  write(path.join(target, "30-Shared"), "a file here");
  const again = planImport(bundle, { targetVault: target, layaDir: path.join(base, "none") });
  assert.deepEqual(again.vault.dirs, ["20-Projects/app-1/checkpoints"]);
  assert.match(again.warnings.join("\n"), /30-Shared is a folder in the bundle but not here/u);
  applyImport(again);
  assert.ok(fs.existsSync(path.join(target, "20-Projects", "app-1", "checkpoints")));
  assert.equal(read(path.join(target, "30-Shared")), "a file here");
  // A bundle from before the folder list (no manifest.dirs) still imports.
  const { files } = readTarGz(bundle);
  const old = createTarGz(files.map((f) => f.name === "manifest.json"
    ? { ...f, data: Buffer.from(JSON.stringify({ ...JSON.parse(f.data.toString("utf8")), dirs: undefined })) } : f));
  assert.deepEqual(planImport(old, { targetVault: path.join(base, "old"), layaDir: path.join(base, "none") }).vault.dirs, []);
  // An unsafe folder name in a crafted manifest is rejected, never created.
  const evil = createTarGz(files.map((f) => f.name === "manifest.json"
    ? { ...f, data: Buffer.from(JSON.stringify({ ...JSON.parse(f.data.toString("utf8")), dirs: ["vault/../escape", "other/x"] })) } : f));
  const evilPlan = planImport(evil, { targetVault: path.join(base, "evil"), layaDir: path.join(base, "none") });
  assert.deepEqual(evilPlan.vault.dirs, []);
  assert.deepEqual(evilPlan.rejected.map((r) => r.name).sort(), ["other/x", "vault/../escape"]);
  fs.rmSync(base, { recursive: true, force: true });
});

test("a tampered bundle is refused", () => {
  const base = tmp("om-tamper-");
  const vault = makeVault(path.join(base, "vault"), { projects: [] });
  const { bundle } = buildExport(vault, { layaDir: path.join(base, "none") });
  const { files } = readTarGz(bundle);
  const tampered = createTarGz(files.map((f) => f.name === "vault/AGENTS.md" ? { ...f, data: Buffer.from("changed") } : f));
  assert.throws(() => planImport(tampered, { targetVault: path.join(base, "t") }), /does not match its checksum/u);
  const noManifest = createTarGz(files.filter((f) => f.name !== "manifest.json"));
  assert.throws(() => planImport(noManifest, { targetVault: path.join(base, "t") }), /no manifest/u);
  fs.rmSync(base, { recursive: true, force: true });
});

test("mergeProjects and mergeLog are no-ops on identical input", () => {
  const yaml = "projects:\n  - id: a\n    roots:\n      - /x\n    scope: private\n";
  assert.equal(mergeProjects(yaml, yaml).text, yaml);
  const log = "# Log\n\n## [2026-01-01] ingest | x\n\n- y\n";
  assert.deepEqual(mergeLog(log, log), { text: log, added: 0 });
});

test("omem export / import CLIs: encrypted round trip, dry run by default, hosts to repoint", async () => {
  const base = tmp("om-cli-");
  const vault = makeVault(path.join(base, "vault"), { projects: [{ id: "app-1", roots: ["/elsewhere/app"] }] });
  const layaDir = path.join(base, "laya");
  write(path.join(layaDir, "labels.jsonl"), "{\"t\":1}\n");
  const out = sink();
  const getPassphrase = async () => "a long passphrase";
  assert.equal(await exportMain(["--vault", vault, "--out", base, "--encrypt"], out, sink(), { layaDir, getPassphrase, now: new Date(2026, 10, 27, 10, 0, 0) }), 0);
  const file = path.join(base, "obsidian-memory-export-20261127-100000.tar.gz.enc");
  assert.ok(isEncrypted(fs.readFileSync(file)));
  assert.match(out.text, /encrypted/u);
  assert.equal(await exportMain(["--vault", vault, "--out", path.join(vault, "x.tar.gz")], sink(), sink(), { layaDir }), 1, "never inside the Vault");

  const target = path.join(base, "imported");
  const dry = sink();
  assert.equal(await importMain([file, "--vault", target], dry, sink(), { layaDir: path.join(base, "laya2"), getPassphrase }), 0);
  assert.match(dry.text, /Dry run: nothing written/u);
  assert.ok(!fs.existsSync(target));
  const err = sink();
  assert.equal(await importMain([file, "--vault", target], sink(), err, { layaDir: path.join(base, "laya2"), getPassphrase: async () => "not the passphrase" }), 1);
  assert.match(err.text, /wrong passphrase/u);

  const done = sink();
  const collectHosts = () => ({ hosts: [
    { host: "Codex", install: { installed: true }, vaults: [{ path: "/old/vault" }] },
    { host: "Hermes", install: { installed: true }, vaults: [{ path: target }] },
    { host: "Antigravity", install: { installed: false }, vaults: [] }
  ] });
  assert.equal(await importMain([file, "--vault", target, "--yes"], done, sink(), { layaDir: path.join(base, "laya2"), getPassphrase, collectHosts }), 0);
  assert.equal(read(path.join(target, "AGENTS.md")), "# Vault\n");
  assert.match(done.text, /Codex \(now \/old\/vault\):\n\s+node ".*setup-codex\.mjs" --vault ".*imported" --yes/u);
  assert.doesNotMatch(done.text, /Hermes \(now/u);
  assert.doesNotMatch(done.text, /Antigravity/u);
  assert.equal(await importMain(["--vault", target], sink(), sink()), 1, "a bundle is required");
  fs.rmSync(base, { recursive: true, force: true });
});

test("collectVaultFiles skips names that cannot exist on every system", { skip: process.platform === "win32" && "Windows cannot create such a name" }, () => {
  const base = tmp("om-names-");
  write(path.join(base, "10-Global", "a:b.md"), "x");
  write(path.join(base, "10-Global", "ok.md"), "x");
  const { files, skipped } = collectVaultFiles(base);
  assert.deepEqual(files.map((f) => f.rel), ["10-Global/ok.md"]);
  assert.match(skipped[0].reason, /cannot be created on every system/u);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- routing

test("export / import requests are routed as memory maintenance; ordinary exports are not", async () => {
  const { evaluateFastPath } = await import("../lib/memory-router/fast-path.js");
  const { buildLayaActionNotice } = await import("../lib/prompt.js");
  const cases = {
    "帮我导出知识库": "export",
    "把记忆导出来，我要迁移到另一台电脑": "export",
    "备份一下记忆": "export",
    "知识库迁移到新电脑": "export",
    "export my vault": "export",
    "导入这个记忆包 ~/Downloads/obsidian-memory-export-20261127-100000.tar.gz": "import",
    "恢复我的记忆库": "import",
    "import this memory bundle": "import"
  };
  for (const [text, kind] of Object.entries(cases)) {
    const r = evaluateFastPath(text);
    assert.equal(r.action, "force_maintenance", text);
    assert.equal(r.maintenanceKind, kind, text);
  }
  for (const text of ["把报表导出 Excel", "导入数据库备份", "怎么导出 Excel 表格", "导出这个函数给别的模块用"]) {
    assert.notEqual(evaluateFastPath(text).maintenanceKind, "export", text);
    assert.notEqual(evaluateFastPath(text).maintenanceKind, "import", text);
  }
  const notice = buildLayaActionNotice({ maintenanceRecommended: true, maintenanceKind: "import", scope: "project" });
  assert.match(notice, /import a memory bundle/u);
  assert.match(notice, /omem import; dry run first/u);
});

// ---------------------------------------------------------------- omem command

test("omem dispatches the memory tools, points service commands to laya, and links itself without clobbering", async () => {
  const { runOmem, OMEM_COMMANDS } = await import("../scripts/omem.mjs");
  const { linkCommand, unlinkCommand, omemScript } = await import("../lib/cli-link.js");
  const out = sink();
  const err = sink();
  assert.equal(runOmem(["help"], { stdout: out, stderr: err }), 0);
  for (const name of Object.keys(OMEM_COMMANDS)) assert.match(out.text, new RegExp(`omem ${name}\\b`, "u"), name);
  assert.equal(runOmem(["status"], { stdout: out, stderr: err }), 1);
  assert.match(err.text, /managed with `laya status`/u);

  const dir = tmp("om-bin-");
  const env = { OBSIDIAN_MEMORY_BIN_DIR: dir, PATH: dir };
  const r = linkCommand("omem", omemScript(), { env });
  assert.equal(r.ok, true);
  assert.equal(r.onPath, true);
  if (process.platform !== "win32") assert.equal(fs.readlinkSync(path.join(dir, "omem")), omemScript());
  else assert.match(read(path.join(dir, "omem.cmd")), /scripts[\\/]omem\.mjs/u);
  assert.equal(linkCommand("omem", omemScript(), { env }).ok, true, "relinking our own link is fine");
  // Someone else's `omem` is never replaced.
  const foreign = tmp("om-bin-foreign-");
  write(path.join(foreign, process.platform === "win32" ? "omem.cmd" : "omem"), "#!/bin/sh\necho mine\n");
  const kept = linkCommand("omem", omemScript(), { env: { OBSIDIAN_MEMORY_BIN_DIR: foreign } });
  assert.equal(kept.ok, false);
  assert.match(kept.reason, /not the plugin's/u);
  unlinkCommand("omem", omemScript(), { env });
  assert.equal(fs.existsSync(path.join(dir, process.platform === "win32" ? "omem.cmd" : "omem")), false);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(foreign, { recursive: true, force: true });

  // The real entry point runs a tool.
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, [omemScript(), "projects", "--help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /omem projects bind/u);
});
