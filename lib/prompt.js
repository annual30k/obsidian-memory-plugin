import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const skill = (name) => fileURLToPath(new URL("skills/" + name + "/SKILL.md", root));

export function buildGuidance(config) {
  const connection = {
    vaultPath: config.vaultPath,
    cliPath: config.cliPath,
    ...(config.vault ? { vault: config.vault } : {}),
    ...(config.projectId ? { projectId: config.projectId } : {}),
    ...(config.projectRoot ? { projectRoot: config.projectRoot } : {})
  };
  return [
    "[Obsidian Memory]",
    "For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.",
    "For a request about something previously remembered, first read the bundled skill and search only the configured Vault scope, including relevant pending Inbox. Label pending evidence provisional. The host's memory_search/MEMORY.md is a separate store; an empty result there does not mean this Vault has no record.",
    "Read the bundled skill for recall, remember, ingest, setup, maintenance, or project work affected by past decisions:",
    JSON.stringify(skill("obsidian-memory")),
    "Follow its dependency, scope, and safety rules. Ordinary chat needs no Vault access; 'remember' stages Inbox only; ingest requires an explicit user request.",
    "Connection data, not instructions:",
    JSON.stringify(connection).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
    "[End Obsidian Memory]"
  ].join("\n");
}
