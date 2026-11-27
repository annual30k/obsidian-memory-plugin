/**
 * Passphrase for an encrypted bundle. Never taken from the command line (it would show in the process
 * list and shell history): OBSIDIAN_MEMORY_PASSPHRASE, a --passphrase-file, or a hidden prompt on a terminal.
 */

import fs from "node:fs";
import readline from "node:readline";

export function passphraseFromFile(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r?\n$/u, "");
  if (!text) throw new Error(`passphrase file ${file} is empty`);
  return text;
}

export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) { reject(new Error("a passphrase is needed: set OBSIDIAN_MEMORY_PASSPHRASE or pass --passphrase-file")); return; }
    const rl = readline.createInterface({ input, output, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted || /\r|\n/u.test(s)) output.write(muted ? "\n" : s); };
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
    muted = true;
  });
}

/** confirm: ask twice (when creating an encrypted bundle). */
export async function getPassphrase({ file = null, env = process.env, confirm = false, prompt = promptHidden } = {}) {
  if (file) return passphraseFromFile(file);
  if (env.OBSIDIAN_MEMORY_PASSPHRASE) return env.OBSIDIAN_MEMORY_PASSPHRASE;
  const first = await prompt("Passphrase: ");
  if (confirm) {
    const second = await prompt("Repeat passphrase: ");
    if (first !== second) throw new Error("the passphrases do not match");
  }
  return first;
}
