# 0.4.3 recall acceptance — 2026-09-18

Manual, model-backed runs with `tests/behavior-smoke.mjs`, an isolated host home,
fresh session per scenario, and a disposable synthetic Vault. The test copied
only host authentication into a temporary directory and removed that directory
afterward. It did not use the user's real Vault or running OpenClaw Gateway.

| Host | Runtime/model | Project pending | Global pending | Wiki/Inbox conflict | Vault changes |
| --- | --- | --- | --- | --- | --- |
| Codex | isolated marketplace install of the packed 0.4.3 plugin; configured ChatGPT model | pass, 42.3 s | pass, 43.9 s | pass, 49.9 s | none |
| OpenClaw | 2026.9.2, `main`, `xiaomi-token-plan/mimo-v2.5-pro`, extracted 0.4.3 package | pass, 30.0 s | pass, 25.7 s | pass, 28.2 s | none |

Both hosts reported the relevant Inbox candidate as pending with a source path,
kept Global separate from the default project, and displayed conflicting Wiki
and Inbox evidence without resolving or ingesting it. Neither answer included
the other private project's planted “周二” fact. Vault SHA-256 inventories before
and after each turn matched. This does not prove that the model never read an
unrelated file; the test checks response leakage and filesystem changes, not a
complete read trace. Ordinary chat, explicit remember/ingest, and Hermes model
behavior were not exercised in this run.

Before the fix, the OpenClaw `before_prompt_build` hook ran but system-context
guidance was ignored in favor of the host's `memory_search`/`MEMORY.md`: the
project-pending test incorrectly answered “no record”. In a diagnostic isolated
copy, moving identical guidance to `prependContext` passed all three scenarios.
The 0.4.3 packaged implementation reproduced those passing results. This is a
single-run acceptance observation, not a guarantee across all models or prompts.
