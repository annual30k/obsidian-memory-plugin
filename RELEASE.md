# Release boundary

`obsidian-memory-plugin` is a standalone, host-neutral Plugin and Skill package.
It is not a submodule, runtime service, database, or private extension of an application that happens to use it.

## Release artifact

Each release publishes one immutable `npm pack` archive and a checksum. The archive contains the Plugin entry point, manifests, Skill, references, templates and runtime validation scripts; source tests stay in the GitHub release source tree. It never contains `node_modules`, a Vault, user notes, or another application's source tree.

## Compatibility

Host integrations consume a pinned plugin version and checksum. An application-level adapter may write health- or product-specific facts to the selected Vault project, but must not copy this Plugin's workflow or silently change its Vault configuration.

## Before a GitHub Release

1. Confirm that the release remains covered by the repository's MIT License.
2. Run `npm run check`, `npm test`, `npm run check:antigravity`, `npm run check:codex`, and `npm pack`.
3. Publish the generated archive, SHA-256 checksum, release notes, and host compatibility matrix together.
4. Run `node tests/host-package-smoke.mjs <archive.tgz>` and `node tests/openclaw-smoke.mjs <archive.tgz>` against that exact archive. These cover packaged Antigravity, Codex and Hermes entrypoints, the shared Skill, and isolated OpenClaw host loading; they do not prove model behavior. In an isolated `CODEX_HOME`, also add this repository as a Marketplace and install `obsidian-memory@obsidian-memory` after the release commit is public; verify the installed version matches the tag.
5. For memory behavior changes, run the relevant isolated, synthetic-Vault conversations in `tests/skill-scenarios.md` on the intended host/model. Record the observed recall, provenance, scope, writes and latency; passing unit and package tests alone is not proof of agent behavior.

## GitHub Release Publishing & Title Conventions

Whenever publishing a new release, the following rules **MUST ALWAYS** be followed:

1. **Atomic Release (同步创建 GitHub Release)**:
   - Pushing the git tag alone (`git push origin v<X.Y.Z>`) is **insufficient**.
   - A GitHub Release **must** be created simultaneously, attaching the immutable archive (`dist/obsidian-memory-plugin-<version>.tgz`) and `SHA256SUMS`.
2. **Version-First Title Convention (版本号必须置于最前)**:
   - The Release Title **must begin with the version number**:
     `v<X.Y.Z> — <Short Description>`
   - Examples:
     - ✅ `v0.5.2 — Laya proactive memory & zero-config auto mode`
     - ✅ `v0.4.4 — Windows compatibility fixes`
     - ❌ `Obsidian Memory v0.5.2` (Forbidden: do not place product name before version).
3. **Release Command**:
   ```bash
   # Extract credentials if GH_TOKEN is not already exported
   export GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n' | git credential fill | awk -F= '$1=="password"{print $2}')"

   # Create GitHub release with assets attached
   gh release create "v<VERSION>" \
     "dist/obsidian-memory-plugin-<VERSION>.tgz" \
     SHA256SUMS \
     --title "v<VERSION> — <Description>" \
     --notes-file "<path-to-release-notes.md>"
   ```
