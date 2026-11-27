# Move the memory to another machine

Read when the user asks to export, back up, migrate or import the memory. These
are `omem` subcommands and need no Laya service; without the `omem` command run
`node <plugin root>/scripts/export-vault.mjs` / `import-vault.mjs` /
`projects-vault.mjs` with the same arguments (see [tools.md](tools.md)).

## Export: `omem export` (`export-vault.mjs`)

`omem export --out <folder outside the Vault>`

- Read-only for the Vault. Packs every note (not `.obsidian`, `.git`, `.trash`,
  other tools' dot folders or symlinks) plus `~/.laya` labels and trained heads
  into `obsidian-memory-export-<time>.tar.gz`. The bundle's copy of
  `projects.yaml` records each local checkout's Git remote.
- `--project <id>` (repeatable) exports one project; add `--no-global` when it
  goes to someone else. A partial export leaves out Laya data (it holds prompts
  from every project) unless `--with-laya`.
- `--encrypt` asks for a passphrase on the terminal. The agent never chooses,
  asks for or types it: tell the user to run the command themselves, or to set
  `OBSIDIAN_MEMORY_PASSPHRASE` / pass `--passphrase-file`. Recommend it whenever
  the file will travel through a chat app or cloud drive.
- Report what was left out and any lines flagged as credentials (paths and
  line numbers only). `--with-decisions` and `--with-obsidian-config` include
  private prompt logs and plugin settings that may contain API keys: only on an
  explicit request.

## Import: `omem import` (`import-vault.mjs`)

1. Dry run: `omem import <file> [--vault <folder>]`. The default target is the
   Vault this machine's hosts already use; with none, ask the user where the
   Vault should live (an empty folder gets a fresh copy). Show the user the
   plan: files added, logs merged, conflicts, projects and how each is placed.
2. Projects whose code is here under another path: a Git project binds itself
   the first time its checkout is opened (by remote). For the others ask the
   user for the directory and add `--map <id>=<dir>`. Never search the disk.
3. After the user confirms, run the same command with `--yes`.
4. Follow-up the output lists, each with the user's consent:
   - hosts still pointing at another Vault: run the printed setup commands;
   - `00-System/import-conflicts/<time>/`: notes that differed. Merge each
     imported copy into the local note following Ingest rules (update the
     canonical note, mark real contradictions). Never rewrite a local Raw
     note: report a differing Raw to the user instead. Delete the folder only
     when every pair is resolved;
   - `omem index` for semantic hints, `laya train` when labels were merged.

Templates are never conflicts: an unedited older local template is upgraded to
the bundle's current one; an edited or hand-written one is kept and listed, and
`--use-incoming-templates` replaces it (backed up to
`00-System/template-backups/<time>/`). Offer that flag when the dry run shows
local templates lacking core fields. Files that differ only in line endings
(Windows CRLF) count as identical.

An existing Vault is merged, never overwritten: identical files are skipped,
new files added, `log.md` entries appended, `projects.yaml` merged by id (roots
and remotes only added), `.obsidian` kept local. A project the two machines
created under different ids for the same repository is reported (shared
remote); ask the user before merging such projects.

## Projects across machines: `omem projects` (`projects-vault.mjs`)

- `omem projects` lists each project, its roots (marking those on this machine)
  and remotes.
- `omem projects bind <id> [<dir>] --yes` adds this machine's checkout to an
  existing project (see "Resolve and onboard a project").
- `omem projects backfill-remotes --yes` records the remotes of every project
  checked out here; offer it once after an upgrade, with the user's consent.
