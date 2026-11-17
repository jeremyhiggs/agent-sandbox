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
import { basename, join } from "node:path";

export function buildOS(): string {
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
        "agent-container:os",
        output,
      ],
      { cwd: root, stdio: "inherit" },
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
