import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packagePins } from "../image/packages.ts";

const root = join(import.meta.dirname, "..");
const toml = (file: string) =>
  JSON.parse(
    execFileSync("taplo", ["get", "-f", join(root, file), "-o", "json"], {
      encoding: "utf8",
    }),
  );
const config = toml("mise.toml");
const host = toml("mise.lock");
assert.equal(config.tool_config.locked, true);
assert.equal(config.settings.npm.package_manager, "aube");
assert.equal(host.lockfile_version, 4);
for (const [name, pin] of Object.entries(config.tools)) {
  const version =
    typeof pin === "string" ? pin : (pin as { version: string }).version;
  const entries = host.tools[name];
  assert.equal(entries?.length, 1, `Missing or ambiguous host lock: ${name}`);
  const entry = entries[0];
  assert.equal(entry.version, version, `Host lock differs from pin: ${name}`);
  assert.ok(
    Array.isArray(entry.specifiers) && entry.specifiers.includes(version),
    `Host lock does not bind the configured request: ${name}`,
  );
  if (name.startsWith("npm:")) {
    assert.match(entry.aube.digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(entry.aube.path.startsWith(".mise/locks/"));
    let sidecar = root;
    for (const component of entry.aube.path.split("/")) {
      assert.ok(
        component && component !== "." && component !== "..",
        "Invalid sidecar path",
      );
      sidecar = join(sidecar, component);
      assert.ok(
        !lstatSync(sidecar).isSymbolicLink(),
        "Symlink in sidecar path",
      );
    }
    for (const file of ["aube-lock.yaml", "package.json"])
      assert.ok(
        !lstatSync(join(sidecar, file)).isSymbolicLink(),
        "Symlinked sidecar file",
      );
    const graph = readFileSync(
      join(root, entry.aube.path, "aube-lock.yaml"),
      "utf8",
    );
    const digest = (text: string) =>
      `sha256:${createHash("sha256").update(text).digest("hex")}`;
    assert.ok(
      [digest(graph), digest(graph.replaceAll("\r\n", "\n"))].includes(
        entry.aube.digest,
      ),
      `npm graph digest mismatch: ${name}`,
    );
    const manifest = JSON.parse(
      readFileSync(join(root, entry.aube.path, "package.json"), "utf8"),
    );
    assert.deepEqual(manifest.dependencies, { [name.slice(4)]: version });
    const parsed = JSON.parse(
      execFileSync("yq", ["-o=json", ".", "-"], {
        encoding: "utf8",
        input: graph,
      }),
    );
    const dependency = parsed.importers?.["."]?.dependencies?.[name.slice(4)];
    assert.equal(
      dependency?.specifier,
      version,
      `npm graph specifier differs: ${name}`,
    );
    assert.equal(
      dependency?.version?.split("(")[0],
      version,
      `npm graph version differs: ${name}`,
    );
    const packages = Object.values(parsed.packages ?? {}) as {
      resolution?: { integrity?: string };
    }[];
    assert.ok(packages.length, `Empty npm graph: ${name}`);
    for (const artifact of packages) {
      const integrity = artifact.resolution?.integrity ?? "";
      assert.match(
        integrity,
        /^sha512-[A-Za-z0-9+/]{86}==$/,
        `Unverified npm artifact: ${name}`,
      );
      assert.equal(
        Buffer.from(integrity.slice(7), "base64").length,
        64,
        `Invalid SHA-512 integrity: ${name}`,
      );
    }
  } else {
    for (const platform of name === "container"
      ? ["macos-arm64"]
      : ["linux-x64", "linux-arm64", "macos-arm64"]) {
      const artifact =
        entry[`platforms.${platform}`] ?? entry.platforms?.[platform];
      assert.ok(artifact, `Missing host platform: ${name}/${platform}`);
      assert.match(artifact.checksum, /^sha256:[a-f0-9]{64}$/);
      assert.ok(artifact.url.startsWith("https://"));
    }
  }
}
console.log(
  "Host tools: locked versions, SHA-256 artifacts and SHA-512 npm graphs",
);

const image = join(import.meta.dirname, "..", "image");
for (const arch of ["arm64", "amd64"]) {
  const pins = packagePins(arch);
  assert.equal(
    new Set(pins.map((pin) => pin.split("=", 1)[0])).size,
    pins.length,
    "Duplicate package in native lockfile",
  );
  for (const [name, tool] of [
    ["nodejs-24", "NODE"],
    ["gh", "GH"],
  ])
    assert.ok(
      pins.some((pin) =>
        pin.startsWith(`${name}=${process.env[`IMAGE_${tool}_VERSION`]}-`),
      ),
      `${name} lock differs from mise pin`,
    );
  console.log(`apko/${arch}: ${pins.length} exact package pins`);
}
assert.match(process.env.IMAGE_MISE_BASE ?? "", /@sha256:[a-f0-9]{64}$/);
assert.ok(
  process.env.IMAGE_MISE_BASE?.includes(`:${process.env.IMAGE_MISE_VERSION}@`),
);
const artifacts = JSON.parse(
  readFileSync(join(image, "artifacts.json"), "utf8"),
);
for (const tool of ["pnpm", "hc"]) {
  assert.equal(
    artifacts[tool].version,
    process.env[`IMAGE_${tool.toUpperCase()}_VERSION`],
    `${tool} archive lock differs from mise pin`,
  );
  for (const entry of tool === "pnpm"
    ? [artifacts.pnpm]
    : [artifacts[tool].arm64, artifacts[tool].amd64]) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.url.startsWith("https://"));
  }
}
for (const [profile, dependency, variable] of [
  ["base", "agent-browser", "AGENT_BROWSER"],
  ["codex", "@openai/codex", "CODEX"],
  ["opencode", "@opencode/cli", "OPENCODE"],
  ["claude", "@anthropic-ai/claude-code", "CLAUDE"],
]) {
  const tools = JSON.parse(
    readFileSync(join(image, "tools", profile, "package.json"), "utf8"),
  );
  assert.deepEqual(tools.dependencies, {
    [dependency]: process.env[`IMAGE_${variable}_VERSION`],
  });
}
console.log(
  "Native OS lock, mise image digest, tool archives and version pins agree",
);
