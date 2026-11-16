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
for (const tool of ["JJ", "HC"]) {
  const entries: Record<string, unknown> = { version: version(tool) };
  for (const [arch, triple] of [
    ["arm64", "aarch64"],
    ["amd64", "x86_64"],
  ]) {
    const release = manifest.targets[`linux-${triple}`];
    entries[arch] =
      tool === "JJ"
        ? await artifact(
            `https://github.com/jj-vcs/jj/releases/download/v${version(tool)}/jj-v${version(tool)}-${triple}-unknown-linux-musl.tar.gz`,
          )
        : await artifact(release.url, release.sha256);
  }
  lock[tool.toLowerCase()] = entries;
}
const tools = join(root, "tools");
mkdirSync(tools, { recursive: true });
writeFileSync(
  join(tools, "package.json"),
  `${JSON.stringify(
    {
      name: "codex-container-image-tools",
      private: true,
      dependencies: {
        "@openai/codex": version("CODEX"),
        "agent-browser": version("AGENT_BROWSER"),
      },
    },
    null,
    2,
  )}\n`,
);
execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
  cwd: tools,
  stdio: "inherit",
});
execFileSync(
  "pnpm",
  ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"],
  { cwd: tools, stdio: "inherit" },
);
writeFileSync(
  join(root, "artifacts.json"),
  `${JSON.stringify(lock, null, 2)}\n`,
);
