# Minimal note templates

Read before initialization, project onboarding, or creating a memory note. The
plugin ships memory-specific templates only; syntax and I/O remain owned by the
host's Obsidian skills.

## Template selection

Use a compatible existing `00-System/templates/<name>` first. For a missing
template, read the corresponding packaged asset below and instantiate the note
from it through the installed skills. An ordinary capture need not modify
`00-System/`. Only authorized initialization copies missing template files into
that directory. Never overwrite an existing template automatically.

If a local template lacks required identity/evidence fields, add them to the
new note while preserving local fields; do not silently migrate old notes. If
the local schema conflicts with lifecycle, privacy or immutability rules, stop
and request a merge decision.

| Template | Use |
| --- | --- |
| [project-agent.md](../assets/templates/project-agent.md) | Project identity and self-growing taxonomy contract |
| [project-rules.md](../assets/templates/project-rules.md) | User-supplied project conventions, initially empty |
| [inbox-memory-candidate.md](../assets/templates/inbox-memory-candidate.md) | Pending evidence, never automatic synthesis |
| [credential-reference.md](../assets/templates/credential-reference.md) | Explicitly requested secure-storage location metadata |
| [raw-task-record.md](../assets/templates/raw-task-record.md) | Immutable evidence snapshot |
| [decision.md](../assets/templates/decision.md) | Decision, alternatives and evidence-backed rationale |
| [pitfall.md](../assets/templates/pitfall.md) | Verified cause and avoidance |
| [knowledge.md](../assets/templates/knowledge.md) | General synthesis and unresolved questions |
| [checkpoint.md](../assets/templates/checkpoint.md) | Durable blockers and remaining work |
| [project-index.md](../assets/templates/project-index.md) | Project navigation |
| [project-log.md](../assets/templates/project-log.md) | Append-only project chronology |
| [global-preferences.md](../assets/templates/global-preferences.md) | Initially empty; preferences change only on ingest |
| [global-index.md](../assets/templates/global-index.md) | Global navigation |
| [global-log.md](../assets/templates/global-log.md) | Append-only Global chronology |

## Instantiation contract

- `{{...}}` denotes a template placeholder, not literal note content. Fill only
  known values; serialize frontmatter strings safely rather than blindly
  substituting unescaped titles/paths. No unresolved placeholders in created
  notes. Empty sections are intentional: they do not license invented facts.
- IDs are stable. Use `scope: project`, `global` or explicitly approved `shared`.
  Fill `project_id` only for project scope; keep it YAML null otherwise. Use real
  RFC 3339 times. Required evidence/source fields must not be invented; identify
  a conversation source by an available message/session reference or an honest
  description plus timestamp when no stable locator is exposed.
- Candidate templates begin pending, with `raw_record: null`. Raw uses the same
  candidate ID and includes factual evidence, not a later summary. Attachments
  are quoted full-Vault-relative links and copied bytes, not remote placeholders.
- Derived notes keep `title/type/status/created/last_updated/sensitivity/sources`,
  and `decision`/`pitfall`/`knowledge`/`checkpoint` templates include
  `deprecated: false` by default (older notes without `deprecated` default to
  `false`). When marking a derived note deprecated/superseded, set
  `deprecated: true` and optionally record `deprecated_at` (`YYYY-MM-DD`),
  `deprecated_reason`, `superseded_by` (quoted Wikilink to the replacement note,
  or `null`), plus a top `> [!warning]` callout in the body.
  `sources` is a YAML list of quoted full-Vault-relative Raw wikilinks. An
  ingest-created derived page needs at least one verified source; an empty
  bootstrap preference page may have `sources: []` and `status: uninitialized`.
- Core frontmatter fields are required on every note, whatever its body looks
  like (Lint reports missing ones; fill them when a note is next edited):
  - candidate / credential reference: `schema_version`, `id`, `title`, `type`,
    `scope`, `project_id`, `status`, `created`, `sensitivity`, `source_ref`;
  - Raw: the same plus `candidate_id` and `captured_at`, with `status: frozen`;
  - derived (`decision`/`pitfall`/`knowledge`/`checkpoint`): `title`, `type`,
    `scope`, `project_id`, `status`, `deprecated`, `created`, `last_updated`,
    `sensitivity`, `sources`.
  Keep any other existing keys (`origin`, `source_hash`, `aliases`, `tags`, ...).
- Body headings: a template's `##` sections are the default outline. A page with
  its own natural structure (an operations manual, SOP or step-by-step guide)
  may use domain headings instead, such as `一、操作入口` / `二、操作步骤`; keep
  the template's names for the evidence and related-notes sections when the
  page has them (`Supporting evidence and inference`, `Related notes`), and do
  not add empty template sections just to match the outline.
- For Wiki pages with code snippets or multiple screenshots:
  - Lead the page and each `##` section with a concise plain-language summary
    before code blocks. Keep key commented code snippets in `wiki/` using
    fenced ` ```lang ` blocks; place full long source files or raw logs in `raw/`.
  - For multi-image pages, maintain an attachment index table near the end:
    `| File | Screen / Step | Key controls & details |`
- Template `sensitivity: internal` is only a non-sensitive default. Copy a
  confidential candidate's classification to Raw and any derived content; never
  downgrade it during ingest or merge it into less-private notes. A derived page
  incorporating confidential evidence must keep the more restrictive scope.
- The starter decision/pitfall/knowledge categories are not the final business
  taxonomy. Establish or extend it from actual evidence at authorized ingest;
  preserve the common source fields in any new page type.
- Never put credential values into any field, including a title, source URL,
  evidence, attachment or log. The credential template's evidence is only the
  permitted location metadata; keep confidential provenance private.
