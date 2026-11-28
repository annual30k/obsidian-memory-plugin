# Plugin tools

Read when a Recall step calls for `omem search`, on a lint request, or after an
ingest that changed many notes. All three are read-only for the Vault.

Each tool is an `omem` subcommand (host setup links the command; older
installs also accept `laya <tool>`). Without the `omem` command, run the script
from the plugin root (the folder that contains `skills/`, two folders above
`SKILL.md`) with the same arguments: `node <plugin root>/scripts/<script> ...`.
Only `omem index` needs the Laya service.

Export, import and cross-machine project binding are in [transfer.md](transfer.md).
Template install and checks (`omem templates`) are in [templates.md](templates.md).
`omem ingest freeze|complete|status` is part of the Ingest steps in SKILL.md;
`omem reconcile` is in [transfer.md](transfer.md).

## Section search: `omem search` (`search-vault.mjs`)

`omem search "<query>" --cwd <project root>`

- Use it when the user describes something in their own words rather than the
  notes' exact terms, or when `rg` finds nothing. Prefer `rg` for exact names,
  UI controls, error codes and code symbols.
- Searches the current project and Global (`--scope all` or
  `--project <id>` to widen or pin), skips deprecated notes unless
  `--include-deprecated`, and returns each hit as `path:startLine-endLine`, the
  best `##` section and a snippet. Read only that line range. `--json` for
  structured output.
- Works without the Laya service (word search over titles, headings and body);
  with the service it adds semantic matching.

## Vault check: `check-vault.mjs`

`node <plugin root>/scripts/check-vault.mjs --vault <vault path>`
(or `npm run check:vault -- --vault <path>` in the plugin folder)

Run it first on a lint request and report its findings. It checks templates
(present, and carrying their core fields),
broken links and sources, `superseded_by` targets of deprecated pages,
sub-index links, scale thresholds (>= 40 Wiki notes or >= 250 `index.md` lines
without a split), wiki references to repository files that no longer exist
(renamed or moved: update the path; deprecate only if the approach is
obsolete), notes missing core frontmatter fields, and plaintext credentials.
Then review what it cannot see: contradictions, outdated claims, orphan pages,
missing concepts.

## Vector backfill: `omem index` (`index-vault.mjs`)

`omem index [--max-minutes 30]`

Semantic hints only see a note once its vectors exist; hooks add them gradually,
one batch per turn. After an ingest or edit that added or rewrote many notes
(dozens or more, a migration, a bulk import), tell the user that `omem index`
builds them all at once. It needs the Laya service and writes only the plugin's
cache under `~/.laya/cache/`, never the Vault.
