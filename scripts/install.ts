import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  globSync,
  lstatSync,
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
    "install-dir": {
      type: "string",
      default: join(homedir(), ".local", "share", "agent-sandbox"),
    },
  },
});
const destination = join(resolve(values["bin-dir"]!), "agent-sandbox");
const installation = resolve(values["install-dir"]!);
const marker = join(installation, ".agent-sandbox-install");
// Mise selects the installed pins; the inner shell restores the
// caller's directory so --mount-git without a path selects their current worktree.
function launcherAt(root: string, command: string): string {
  return `#!/bin/sh
exec mise -C ${quote(root)} exec -- sh -c ${quote('cd "$1" || exit\nshift\nexec node "$@"')} ${command} "$PWD" ${quote(join(root, "scripts", "sandbox.ts"))} "$@"
`;
}
const launcher = launcherAt(installation, "agent-sandbox");
const commandFile = lstatSync(destination, { throwIfNoEntry: false });
if (commandFile) {
  if (
    !commandFile.isFile() ||
    ![launcher, launcherAt(ROOT, "agent-sandbox")].includes(
      readFileSync(destination, "utf8"),
    )
  )
    throw new Error(`Refusing to replace an existing command: ${destination}`);
}
if (
  lstatSync(installation, { throwIfNoEntry: false }) &&
  (!lstatSync(installation).isDirectory() ||
    !existsSync(marker) ||
    readFileSync(marker, "utf8") !== "agent-sandbox\n")
)
  throw new Error(
    `Refusing to replace an unrelated directory: ${installation}`,
  );

// Allowlist runtime files: never copy checkout state, dependencies or secrets.
const files = [
  "Dockerfile",
  ".dockerignore",
  "mise.toml",
  "mise.lock",
  ".trivyignore.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ...globSync(
    [
      ".mise/locks/*/*/package.json",
      ".mise/locks/*/*/aube-lock.yaml",
      "scripts/*.ts",
      "image/*.ts",
      "image/*.json",
      "image/*.yaml",
      "image/tools/*/package.json",
      "image/tools/*/pnpm-lock.yaml",
      "skills/*/SKILL.md",
    ],
    { cwd: ROOT },
  ),
];
mkdirSync(installation, { recursive: true });
writeFileSync(marker, "agent-sandbox\n");
for (const file of files) {
  const target = join(installation, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(ROOT, file), target);
}
execFileSync("mise", ["trust", join(installation, "mise.toml")], {
  stdio: "inherit",
});
mkdirSync(resolve(values["bin-dir"]!), { recursive: true });
writeFileSync(destination, launcher, { mode: 0o755 });
console.log(`Installed ${destination}`);
console.log(`Runtime copied to ${installation}`);

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
