# Contributing

Thank you for improving Obsidian Memory Plugin.

## Before opening a pull request

1. Keep changes scoped to this standalone plugin; do not add a Vault, user notes,
   credentials, or copies of the external `kepano/obsidian-skills` dependency.
2. Update documentation and tests for behavior changes.
3. Run the full local verification suite:

   ```sh
   npm run check
   npm test
   npm run check:codex
   npm pack --dry-run
   ```

## Pull requests

- Explain the user-visible behavior and how you verified it.
- Keep commits focused and avoid unrelated formatting churn.
- Do not include secrets, Vault contents, or personal configuration.

## Issues

For bugs, include the plugin version, host (OpenClaw, Codex, or Hermes),
redacted configuration shape, expected behavior, actual behavior, and the exact
validation or reproduction steps.
