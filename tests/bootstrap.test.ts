import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../scripts/sandbox.ts";

test("CI bootstrap never executes a download with a mismatched SHA-256", () => {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-integrity-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "curl"),
      "#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' '#!/bin/sh' 'touch \"$BOOTSTRAP_MARKER\"' > \"$last\"\n",
      { mode: 0o755 },
    );
    for (const arch of ["ARM64", "X64"]) {
      const result = spawnSync("bash", [join(ROOT, "scripts/ci-setup.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "C",
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_ARCH: arch,
          RUNNER_TEMP: root,
          GITHUB_ENV: join(root, "env"),
          GITHUB_PATH: join(root, "path"),
          GITHUB_WORKSPACE: ROOT,
          BOOTSTRAP_MARKER: join(root, "executed"),
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /computed checksums? did not match/i,
      );
      assert.ok(!existsSync(join(root, "executed")));
      assert.ok(!existsSync(join(root, "env")));
      assert.ok(!existsSync(join(root, "path")));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
