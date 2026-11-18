import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "image");
function version(tool: string): string {
  const pin = process.env[`IMAGE_${tool}_VERSION`];
  if (!pin) throw new Error(`Missing IMAGE_${tool}_VERSION; run through mise`);
  return pin;
}
async function artifact(url: string, expected?: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Artifact HTTP ${response.status}: ${url}`);
  const sha256 = createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
  if (expected && sha256 !== expected)
    throw new Error("hc manifest checksum mismatch");
  return { url, sha256 };
}
const manifestResponse = await fetch(
  `https://releases.herdr.dev/core/${version("HC")}/manifest.json`,
);
if (!manifestResponse.ok)
  throw new Error(`hc manifest HTTP ${manifestResponse.status}`);
const manifest = (await manifestResponse.json()) as {
  targets: Record<string, { url: string; sha256: string }>;
};
const lock: Record<string, unknown> = {
  pnpm: {
    version: version("PNPM"),
    ...(await artifact(
      `https://registry.npmjs.org/pnpm/-/pnpm-${version("PNPM")}.tgz`,
    )),
  },
};
const hc: Record<string, unknown> = { version: version("HC") };
for (const [arch, triple] of [
  ["arm64", "aarch64"],
  ["amd64", "x86_64"],
]) {
  const release = manifest.targets[`linux-${triple}`];
  hc[arch] = await artifact(release.url, release.sha256);
}
lock.hc = hc;
for (const [profile, dependency, variable] of [
  ["base", "agent-browser", "AGENT_BROWSER"],
  ["codex", "@openai/codex", "CODEX"],
  ["opencode", "@opencode/cli", "OPENCODE"],
  ["claude", "@anthropic-ai/claude-code", "CLAUDE"],
]) {
  const tools = join(root, "tools", profile);
  mkdirSync(tools, { recursive: true });
  writeFileSync(
    join(tools, "package.json"),
    JSON.stringify(
      {
        name: `agent-sandbox-${profile}`,
        private: true,
        dependencies: { [dependency]: version(variable) },
      },
      null,
      2,
    ) + "\n",
  );
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tools,
    stdio: "inherit",
  });
}
writeFileSync(
  join(root, "artifacts.json"),
  `${JSON.stringify(lock, null, 2)}\n`,
);
