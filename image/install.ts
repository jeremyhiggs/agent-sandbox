import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installedPackages,
  PROFILE_PACKAGES,
  packagePins,
  verifyPackageInventory,
} from "./packages.ts";

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}
type Artifact = { url: string; sha256: string };
type Release = { version: string; arm64: Artifact; amd64: Artifact };
type SingleRelease = Artifact & { version: string };
const locks = JSON.parse(
  readFileSync(join(import.meta.dirname, "artifacts.json"), "utf8"),
) as {
  pnpm: SingleRelease;
  hc: Release;
  passt: Release;
  "podman-compose": SingleRelease;
  "python-dotenv": SingleRelease;
};
const arch = process.arch === "arm64" ? "arm64" : "amd64";
verifyPackageInventory(packagePins(), installedPackages());
async function withVerifiedArchive(
  tool: string,
  artifact: Artifact,
  extension: string,
  extract: (archive: string) => void,
) {
  const response = await fetch(artifact.url);
  if (!response.ok) throw new Error(tool + " archive HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.sha256,
    tool + " archive checksum mismatch",
  );
  const temp = mkdtempSync(join(tmpdir(), tool + "-install-"));
  try {
    const archive = join(temp, "archive" + extension);
    writeFileSync(archive, bytes);
    extract(archive);
  } finally {
    rmSync(temp, { recursive: true });
  }
}

async function install(
  tool: "pnpm" | "hc",
  destination: string,
  members: string[],
) {
  const release = locks[tool];
  assert.equal(
    release.version,
    process.env[tool.toUpperCase() + "_VERSION"],
    tool + " artifact lock differs from mise pin",
  );
  const artifact = tool === "pnpm" ? locks.pnpm : locks.hc[arch];
  await withVerifiedArchive(tool, artifact, ".tar.gz", (archive) => {
    mkdirSync(destination, { recursive: true });
    run("tar", ["-xzf", archive, "-C", destination, ...members]);
  });
}
await install("pnpm", "/opt/pnpm", ["--strip-components=1"]);
symlinkSync("/opt/pnpm/bin/pnpm.cjs", "/usr/local/bin/pnpm");
const manifest = JSON.parse(
  readFileSync("/opt/tools/base/package.json", "utf8"),
) as { dependencies: Record<string, string> };
const { dependency, variable } = PROFILE_PACKAGES.base;
assert.equal(
  manifest.dependencies[dependency],
  process.env[`${variable}_VERSION`],
);
run("pnpm", [
  "--dir",
  "/opt/tools/base",
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
]);
for (const tool of [dependency])
  symlinkSync(
    "/opt/tools/base/node_modules/.bin/" + tool,
    "/usr/local/bin/" + tool,
  );
await install("hc", "/usr/local/bin", ["herdr-core"]);
symlinkSync("herdr-core", "/usr/local/bin/hc");
await withVerifiedArchive("passt", locks.passt[arch], ".deb", (archive) => {
  // Extract the networking executable only. Do not install Debian packages or scripts.
  const data = execFileSync("bsdtar", ["-xOf", archive, "data.tar.xz"]);
  const passt = execFileSync("bsdtar", ["-xOf", "-", "./usr/bin/passt"], {
    input: data,
  });
  writeFileSync("/usr/local/bin/passt", passt, { mode: 0o755 });
  symlinkSync("passt", "/usr/local/bin/pasta");
});
const composeDir = "/opt/podman-compose";
for (const tool of ["podman-compose", "python-dotenv"] as const)
  await withVerifiedArchive(tool, locks[tool], ".whl", (archive) =>
    run("unzip", ["-q", archive, "-d", composeDir]),
  );
writeFileSync(
  "/usr/local/bin/podman-compose",
  '#!/bin/sh\nexec python3.14 /opt/podman-compose/podman_compose.py "$@"\n',
  { mode: 0o755 },
);

const uid = 1000;
const nestedUser = "sandbox";
const nestedHome = "/var/lib/agent-sandbox/podman";
appendFileSync(
  "/etc/passwd",
  `${nestedUser}:x:${uid}:${uid}::${nestedHome}:/bin/bash\n`,
);
appendFileSync("/etc/group", `${nestedUser}:x:${uid}:\n`);
for (const file of ["/etc/subuid", "/etc/subgid"])
  appendFileSync(file, `${nestedUser}:100000:65536\n`);
for (const tool of ["newuidmap", "newgidmap"]) {
  const path = "/usr/bin/" + tool;
  chownSync(path, 0, uid);
  chmodSync(path, 0o4750);
}
for (const path of [
  nestedHome,
  nestedHome + "/.config",
  nestedHome + "/.config/containers",
]) {
  mkdirSync(path, { recursive: true });
  chownSync(path, uid, uid);
}
writeFileSync(
  nestedHome + "/.config/containers/containers.conf",
  '[containers]\ncgroups = "disabled"\n\n[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n',
);
for (const tool of [
  "mise",
  "node",
  "pnpm",
  "agent-browser",
  "hc",
  "podman",
  "podman-compose",
  "pasta",
])
  run(tool, ["--version"]);

rmSync("/opt/pnpm-home/store", { recursive: true, force: true });
