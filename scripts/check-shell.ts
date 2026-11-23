import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const scripts = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*.sh",
  ],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(
    (file) =>
      file && lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile(),
  );
if (scripts.length) {
  const options = { cwd: root, stdio: "inherit" as const };
  execFileSync(
    "shfmt",
    [
      process.argv.includes("--write") ? "-w" : "-d",
      "-i",
      "2",
      "-ci",
      "--",
      ...scripts,
    ],
    options,
  );
  execFileSync("shellcheck", ["--", ...scripts], options);
}
console.log(`Shell checks: ${scripts.length} scripts`);
