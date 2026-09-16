# Release boundary

`obsidian-memory-plugin` is a standalone, host-neutral Plugin and Skill package.
It is not a submodule, runtime service, database, or private extension of an application that happens to use it.

## Release artifact

Each release publishes one immutable `npm pack` archive and a checksum. The archive contains the Plugin entry point, manifests, Skill, references, templates, tests, and validation scripts; it never contains `node_modules`, a Vault, user notes, or another application's source tree.

## Compatibility

Host integrations consume a pinned plugin version and checksum. An application-level adapter may write health- or product-specific facts to the selected Vault project, but must not copy this Plugin's workflow or silently change its Vault configuration.

## Before a GitHub Release

1. Confirm that the release remains covered by the repository's MIT License.
2. Run `npm run check`, `npm test`, `npm run check:codex`, and `npm pack`.
3. Publish the generated archive, SHA-256 checksum, release notes, and host compatibility matrix together.
4. Verify OpenClaw, Codex, and Hermes installation paths against that exact archive.
