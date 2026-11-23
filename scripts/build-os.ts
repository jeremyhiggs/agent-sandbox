import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PROFILES } from "../image/packages.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_DNS = process.env.CONTAINER_DNS ?? "1.1.1.1";

export function prepareBuild(stdout: 1 | 2 = 1): string {
  execFileSync("node", [join(ROOT, "scripts", "check-locks.ts")], {
    stdio: ["inherit", stdout, 2],
  });
  return buildOS(stdout);
}

export function buildImage(
  options: { engine?: string; profile?: string; image?: string; dns?: string },
  osArchive: string,
  stdout: 1 | 2 = 1,
): void {
  const engine = options.engine ?? "container";
  const variant = options.profile ?? "base";
  if (!(PROFILES as readonly string[]).includes(variant))
    throw new Error("Use --profile base|codex|opencode|claude");
  const args = [
    "build",
    "--build-arg",
    `OS_ARCHIVE=${osArchive}`,
    "--pull",
    "--tag",
    options.image ?? `agent-sandbox:${variant}`,
    "--target",
    variant,
  ];
  for (const name of [
    "MISE_BASE",
    "BROWSER_SHA256_ARM64",
    "BROWSER_SHA256_AMD64",
    "PNPM_VERSION",
    "BROWSER_VERSION",
    "CODEX_VERSION",
    "OPENCODE_VERSION",
    "CLAUDE_VERSION",
    "AGENT_BROWSER_VERSION",
    "HC_VERSION",
  ]) {
    const value = process.env[`IMAGE_${name}`];
    if (!value) throw new Error(`Missing IMAGE_${name}; run through mise`);
    args.push("--build-arg", `${name}=${value}`);
  }
  if (engine === "container") args.push("--dns", options.dns ?? DEFAULT_DNS);
  else if (options.dns)
    throw new Error("Build --dns is supported only by Apple's runtime");
  execFileSync(engine, [...args, ROOT], { stdio: ["inherit", stdout, 2] });
}

export function buildOS(stdout: 1 | 2 = 1): string {
  const root = join(import.meta.dirname, "..");
  const arch =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
        ? "amd64"
        : undefined;
  assert.ok(arch, "Unsupported build host architecture");
  const output = mkdtempSync(join(tmpdir(), "agent-os-"));
  const sbom = join(root, ".artifacts", "apko", "sbom", arch, basename(output));
  mkdirSync(sbom, { recursive: true });
  try {
    execFileSync(
      "apko",
      [
        "build",
        "--arch",
        arch,
        "--lockfile",
        "image/apko.lock.json",
        "--vcs=false",
        "--sbom-path",
        sbom,
        "image/apko.yaml",
        "agent-sandbox:os",
        output,
      ],
      { cwd: root, stdio: ["inherit", stdout, 2] },
    );
    function blob(digest: string): string {
      assert.match(digest, /^sha256:[a-f0-9]{64}$/);
      return join(output, "blobs", "sha256", digest.slice(7));
    }
    let manifest = JSON.parse(readFileSync(join(output, "index.json"), "utf8"));
    while (manifest.manifests) {
      assert.equal(
        manifest.manifests.length,
        1,
        "Expected one architecture in the apko output",
      );
      manifest = JSON.parse(
        readFileSync(blob(manifest.manifests[0].digest), "utf8"),
      );
    }
    assert.equal(
      manifest.layers.length,
      1,
      "The apko OS recipe must produce one layer",
    );
    const layer = manifest.layers[0];
    assert.equal(
      layer.mediaType,
      "application/vnd.oci.image.layer.v1.tar+gzip",
    );
    const source = blob(layer.digest);
    const archive = `.artifacts/os-${arch}-${layer.digest.slice(7)}.tar.gz`;
    const staging = join(root, archive + "." + basename(output) + ".tmp");
    try {
      copyFileSync(source, staging);
      renameSync(staging, join(root, archive));
    } finally {
      rmSync(staging, { force: true });
    }
    return archive;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
