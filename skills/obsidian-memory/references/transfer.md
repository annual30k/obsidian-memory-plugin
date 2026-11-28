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
2. Ask before importing a project this Vault does not have yet. One the user
   wants to keep off this machine is left out with `--skip-project <id>`: its
   notes and its `projects.yaml` entry are not imported.
3. Projects whose code is here under another path: a Git project binds itself
   the first time its checkout is opened (by remote). For the others ask the
   user for the directory and add `--map <id>=<dir>`. Never search the disk.
4. After the user confirms, run the same command with `--yes`.
5. Follow-up the output lists, each with the user's consent:
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

Each machine remembers which version of every file it last agreed on with the
other one (`~/.laya/state/sync/`), and every export carries that record. A file
changed on only one side since is then simply taken from that side; only files
both machines changed are conflicts. Vaults that synced before this record
existed (plugin < 0.13.1) have none: if the user still has the bundle both
started from (usually the earlier export), pass it once as
`--base <that bundle>`; ask the user for it rather than guessing.

An existing Vault is merged, never overwritten: identical files are skipped,
new files added, `log.md` entries appended, `projects.yaml` merged by id (roots
and remotes only added), `.obsidian` kept local. A project the two machines
created under different ids for the same code is reported as "probably the
same project" (same name, a code folder of the same name, or a shared remote);
ask the user before merging such projects.

## Same candidates ingested on both machines: `omem reconcile`

Ingest may happen on any machine. An import reconciles by candidate id: the
same candidate and Raw on both sides are recognised as the same, a log entry
for a candidate already ingested here is not appended again, and the index
only gains lines for pages actually added. A page the other machine wrote from
candidates already ingested here is parked in
`00-System/import-conflicts/<time>/same-ingest/<its path>` instead of added.

For each parked page (`omem reconcile` lists them with the local pages citing
the same Raw): merge into the local page what the parked one adds, classifying
it as in an ingest (support, extension, duplicate, conflict; keep real
contradictions visible), then record it with
`omem reconcile fold <parked copy> --into <local page> --yes`. Never just
delete a parked page: the recorded fold (`00-System/reconciliation.jsonl`,
synced with the Vault) is what makes the other machine drop its copy on its
next import, so both converge on one page. A parked page no local page cites
can be moved to its original path instead.

## Projects across machines: `omem projects` (`projects-vault.mjs`)

- `omem projects` lists each project, its roots (marking those on this machine)
  and remotes.
- `omem projects bind <id> [<dir>] --yes` adds this machine's checkout to an
  existing project (see "Resolve and onboard a project").
- `omem projects backfill-remotes --yes` records the remotes of every project
  checked out here; offer it once after an upgrade, with the user's consent.
- `omem projects local <id> --yes` keeps a project on this machine for good
  (`transfer: local` in `projects.yaml`): exports leave out its notes and its
  registry entry, and imports never take another machine's copy of it. Use it
  when the user says a project is private to one machine; `--off` undoes it.
  While such a project exists, exports also leave out Laya labels (they do not
  record their project) unless `--with-laya`, and list other notes that still
  mention it, which the user may want to edit before sending the bundle.
- `omem projects merge <from> <into>`: the same code registered under two ids
  (each machine onboarded it under its own path). Only after the user confirms
  which id survives (usually the one with the notes). Show the dry run, then
  `--yes`. It moves `<from>`'s notes into `<into>` (a project with no notes
  just loses its seed files), appends missing log entries, parks differing
  notes in `00-System/import-conflicts/<time>-merge-<from>/` for you to merge,
  rewrites links to the old folder, joins roots and remotes, removes the
  `<from>` entry and logs the merge. `omem projects` lists likely duplicates;
  `bind` refuses a directory owned by another project and suggests the merge.
