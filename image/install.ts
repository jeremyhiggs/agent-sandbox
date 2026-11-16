import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}
function version(name: string): string {
  const value = process.env[`${name}_VERSION`];
  if (!value) throw new Error(`Missing ${name}_VERSION build argument`);
  return value;
}

run("mise", ["install-into", `jj@${version("JJ")}`, "/opt/jj"]);
symlinkSync("/opt/jj/jj", "/usr/local/bin/jj");
run("npm", ["install", "--global", `npm@${version("NPM")}`]);
run("npm", [
  "install",
  "--global",
  `@openai/codex@${version("CODEX")}`,
  `agent-browser@${version("AGENT_BROWSER")}`,
]);
const base = `https://releases.herdr.dev/core/${version("HC")}`;
const response = await fetch(`${base}/manifest.json`);
if (!response.ok) throw new Error(`hc manifest: HTTP ${response.status}`);
const manifest = (await response.json()) as {
  targets: Record<string, { url: string; sha256: string }>;
};
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const entry = manifest.targets[`linux-${arch}`];
const download = await fetch(entry.url);
if (!download.ok) throw new Error(`hc download: HTTP ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
  throw new Error("hc archive checksum mismatch");
}
const temp = mkdtempSync(join(tmpdir(), "hc-install-"));
try {
  const archive = join(temp, "hc.tar.gz");
  writeFileSync(archive, bytes);
  run("tar", ["-xzf", archive, "-C", temp, "herdr-core"]);
  renameSync(join(temp, "herdr-core"), "/usr/local/bin/herdr-core");
  symlinkSync("herdr-core", "/usr/local/bin/hc");
} finally {
  rmSync(temp, { recursive: true });
}
for (const tool of ["mise", "node", "codex", "agent-browser", "hc", "jj"])
  run(tool, ["--version"]);
run("npm", ["cache", "clean", "--force"]);
// Keep npm's complete dependency inventory in the final image for scanners.
readFileSync("/usr/local/lib/node_modules/agent-browser/package.json");
