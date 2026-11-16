import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { quote, ROOT } from "./sandbox.ts";

const { values } = parseArgs({
  options: {
    "bin-dir": { type: "string", default: join(homedir(), ".local", "bin") },
  },
});
const destination = join(resolve(values["bin-dir"]!), "codex-container");
// Mise selects this repo's pinned environment; the inner shell restores the
// caller's directory so an omitted --checkout selects their current worktree.
const launcher = `#!/bin/sh
exec mise -C ${quote(ROOT)} exec -- sh -c ${quote('cd "$1" || exit\nshift\nexec node "$@"')} codex-container "$PWD" ${quote(join(ROOT, "scripts", "sandbox.ts"))} "$@"
`;
mkdirSync(resolve(values["bin-dir"]!), { recursive: true });
if (existsSync(destination)) {
  if (readFileSync(destination, "utf8") !== launcher)
    throw new Error(`Refusing to replace an existing command: ${destination}`);
} else {
  writeFileSync(destination, launcher, { flag: "wx", mode: 0o755 });
}
console.log(`Installed ${destination}`);
