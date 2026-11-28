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
  goes to someone else. When `--project`, `--no-global`, or `transfer: local`
  projects are present, `labels*.jsonl` is filtered per row by `project_id` /
  `scope`: rows belonging to excluded projects and unattributed legacy rows are
  dropped conservatively (report shows kept vs. filtered counts), trained heads
  are left out for `--project` exports, and `--no-laya` / `--with-laya` still
  override explicitly.
- **Incremental export**: `--incremental` (or `--since <device|bundle>`) packs
  only Vault files added or changed since the last synced baseline (recorded in
  `~/.laya/state/sync/` per peer device) or since an earlier bundle file,
  omitting unchanged files and large attachments while recording their hashes in
  `manifest.json` so the importer can verify them and distinguish "unchanged"
  from "deleted". If no baseline exists yet (or `--full` is passed), `omem export`
  exports a full bundle and explains why. When synced with multiple devices,
  pass `--since <device>` (or `--since <bundle>`). Plain `omem export` without
  `--incremental` / `--since` always creates a self-contained full bundle.
- `--encrypt` asks for a passphrase on the terminal. The agent never chooses,
  asks for or types it: tell the user to run the command themselves, or to set
  `OBSIDIAN_MEMORY_PASSPHRASE` / pass `--passphrase-file`. Recommend it whenever
  the file will travel through a chat app or cloud drive. (When `--since` points
  to an encrypted bundle with a different passphrase, pass
  `--since-passphrase-file <file>`.)
- Report what was left out and any lines flagged as credentials (paths and
  line numbers only). `--with-decisions` and `--with-obsidian-config` include
  private prompt logs and plugin settings that may contain API keys: only on an
  explicit request.

## Import: `omem import` (`import-vault.mjs`)

1. Dry run: `omem import <file> [--vault <folder>]`. The default target is the
   Vault this machine's hosts already use; with none, ask the user where the
   Vault should live (an empty folder gets a fresh copy). Show the user the
   plan: bundle type (full or incremental), import scope, files added, logs
   merged, conflicts, projects and how each is placed.
2. **Scope and anti-pollution filters**:
   - `--only-project <id>` (repeatable): whitelist mode — imports only the named
     project(s)' notes, folders, and `projects.yaml` entries; all other projects
     and Vault root files are ignored. By default skips `10-Global/` (add
     `--with-global` to include it) and leaves `~/.laya` untouched (add
     `--with-laya` to include it). Rejects unknown project IDs not present in
     the bundle, and cannot be combined with `--skip-project`.
   - `--no-global`: in normal import mode, skips `10-Global/` (preferences,
     index, log, Inbox/Raw) so another machine's global memory does not pollute
     this machine.
   - `--skip-project <id>` (repeatable): blacklist mode — leaves specific
     projects out of an otherwise full import.
   - Projects marked `transfer: local` on this machine are always protected
     (never imported or overwritten, even if listed in `--only-project`).
   - Whitelist/partial imports update `~/.laya/state/sync/` only for in-scope
     paths; out-of-scope projects and skipped `10-Global/` are never recorded as
     locally deleted.
3. **Incremental bundles**: `omem import` automatically detects full vs.
   incremental bundles (and remains compatible with v0.15.0 and earlier full
   bundles). Before writing anything, it verifies that the target is an existing
   Vault, matches the target device (for device-based incrementals), and holds
   every in-scope omitted unchanged file (or has a local sync baseline proving a
   local edit). If the baseline does not hold (empty folder, missing unchanged
   files, cross-device or content mismatch), import refuses safely and directs
   the user to export a full bundle (`omem export --full`).
4. **Remote renames and deletions**: using the three-way sync baseline, an
   unmodified local file that disappeared on the other machine while an incoming
   new file has the same ancestor content hash is migrated cleanly as a rename
   (local edits on the old path are kept and the incoming rename is parked as a
   rename/modify conflict). An unmodified local file genuinely deleted on the
   other machine (absent from both payload and an incremental bundle's
   `unchanged` list, inside the active scope, and not a protected core file such
   as `projects.yaml`, `AGENTS.md`, `Home.md`, templates, or scope index/log) is
   propagated and backed up in the pre-import snapshot; if modified locally, it
   is kept and reported as a delete/modify conflict. Only files this machine has
   received from that machine before are deleted or renamed: with only a `--base`
   bundle as proof, missing files are reported and kept. A rename needs exactly
   one old and one new path with the same content; identical copies (template
   notes) are handled as separate deletions and additions.
5. **Pre-import snapshot, one-click rollback, and auto-index**: every
   `omem import --yes` automatically saves a pre-import snapshot outside the
   Vault (`~/.laya/backups/imports/`, keeping the last 10 by default; `--no-backup`
   disables it) covering overwritten/deleted files, added paths, sync state, and
   Laya changes. Undo an import with `omem import rollback [snapshot-id] --yes`
   (`--list` shows snapshots; refuses to overwrite files manually edited after
   import unless `--force`). An import that stops part-way keeps its snapshot,
   so it can be rolled back too; a rollback restores only the sync record for
   the machine that import came from. After Vault writes or rollbacks, `omem`
   automatically refreshes the Laya vector index (pruning stale vectors for
   deleted notes) and degrades gracefully if the Laya service is not running
   (`--no-index` skips it).
6. Projects whose code is here under another path: a Git project binds itself
   the first time its checkout is opened (by remote). For the others ask the
   user for the directory and add `--map <id>=<dir>`. Never search the disk.
7. After the user confirms, run the same command with `--yes`.
8. Follow-up the output lists, each with the user's consent:
   - hosts still pointing at another Vault: run the printed setup commands;
   - `00-System/import-conflicts/<time>/`: notes that differed. Merge each
     imported copy into the local note following Ingest rules (update the
     canonical note, mark real contradictions). Never rewrite a local Raw
     note: report a differing Raw to the user instead. Delete the folder only
     when every pair is resolved. Re-importing the same bundle before that
     does not copy those notes again (listed as already parked); notes that
     differ only in trailing spaces or blank lines are kept as they are;
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
