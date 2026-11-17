import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { quote, ROOT } from "./sandbox.ts";

const { values } = parseArgs({
  options: {
    "bin-dir": { type: "string", default: join(homedir(), ".local", "bin") },
  },
});
const destination = join(resolve(values["bin-dir"]!), "agent-sandbox");
// Mise selects this repo's pinned environment; the inner shell restores the
// caller's directory so --git without a path selects their current worktree.
function launcherAt(root: string, command: string): string {
  return `#!/bin/sh
exec mise -C ${quote(root)} exec -- sh -c ${quote('cd "$1" || exit\nshift\nexec node "$@"')} ${command} "$PWD" ${quote(join(root, "scripts", "sandbox.ts"))} "$@"
`;
}
const launcher = launcherAt(ROOT, "agent-sandbox");
mkdirSync(resolve(values["bin-dir"]!), { recursive: true });
if (existsSync(destination)) {
  if (readFileSync(destination, "utf8") !== launcher)
    throw new Error(`Refusing to replace an existing command: ${destination}`);
} else {
  writeFileSync(destination, launcher, { flag: "wx", mode: 0o755 });
}
console.log(`Installed ${destination}`);

for (const command of ["agent-container", "codex-container"]) {
  const previous = join(resolve(values["bin-dir"]!), command);
  const roots = [ROOT, join(dirname(ROOT), command)];
  if (
    existsSync(previous) &&
    roots.some(
      (root) => readFileSync(previous, "utf8") === launcherAt(root, command),
    )
  ) {
    unlinkSync(previous);
  }
}
