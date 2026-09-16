# Sources and licensing

## Obsidian Memory

The bundled `skills/obsidian-memory/` is adapted from the user-provided
`Obsidian Memory Skill/skills/obsidian-memory/` and
`Obsidian Memory Skill/VAULT-BOOTSTRAP-PROMPT.md`.

The integration preserves selective capture, explicit-user ingest, Raw provenance,
canonical Wiki updates, project isolation, and credential restrictions. It uses
the selected Vault filesystem for managed memory paths, reserves Obsidian CLI for
application-specific operations, and does not infer a code project from the
OpenClaw Gateway directory.

The copyright holder confirmed that this local material may be publicly released
under the repository's [MIT License](LICENSE).

## External dependency: kepano/obsidian-skills

- Repository: https://github.com/kepano/obsidian-skills
- Required host dependency: the complete upstream skill collection, not only CLI
  and Markdown. Verified on 2026-09-04: `obsidian-cli`, `obsidian-markdown`,
  `obsidian-bases`, `json-canvas`, `defuddle`. Check the selected revision's full
  catalog at setup/update; this snapshot is not a permanent limit.
- This plugin does not distribute upstream skill files or implement their operations.
- Install/update them using the host's supported skill installer. Check actual
  loaded names/paths and local CLI help instead of assuming every host has the
  same install layout.
- Install all collection members; load individual skill instructions only when
  relevant to the task. Executable prerequisites are verified separately.

The memory skill describes when and where operations are allowed. The external
skills describe how to operate Obsidian. A skill dependency is not an automatic
permission to modify unrelated host configuration.
