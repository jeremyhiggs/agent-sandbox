import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../scripts/sandbox.ts";

test("installation copies a standalone runtime, upgrades its shim and protects unrelated files", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-install-")));
  const bin = join(root, "bin"),
    source = join(root, "source"),
    installation = join(root, "installed runtime");
  mkdirSync(bin);
  // Keep trust changes inside the fixture; exercise the generated shell shim.
  writeFileSync(
    join(bin, "mise"),
    '#!/bin/sh\nif [ "$1" = trust ]; then exit 0; fi\n[ "$1" = -C ] || exit 1\ncd "$2" || exit\nshift 2\n[ "$1" = exec ] || exit 1\nshift 2\nexec "$@"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const install = (from: string, to: string, destination = bin) =>
    execFileSync(
      process.execPath,
      [
        join(from, "scripts", "install.ts"),
        "--bin-dir",
        destination,
        "--install-dir",
        to,
      ],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    install(ROOT, source);
    // Reproduce the previous checkout-linked launcher for migration coverage.
    const shim = join(bin, "agent-sandbox");
    const sourceShim = readFileSync(shim, "utf8");
    writeFileSync(join(source, ".env"), "PRIVATE_FIXTURE=true\n");
    install(source, installation);
    assert.notEqual(readFileSync(shim, "utf8"), sourceShim);
    renameSync(source, join(root, "moved-source"));
    const guidance = execFileSync(shim, ["--skill"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(
      guidance,
      readFileSync(join(ROOT, "skills", "agent-sandbox", "SKILL.md"), "utf8"),
    );
    assert.equal(
      execFileSync(shim, ["--version"], { cwd: root, env, encoding: "utf8" }),
      `agent-sandbox ${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}\n`,
    );
    assert.ok(lstatSync(join(installation, "scripts", "sandbox.ts")).isFile());
    assert.ok(existsSync(join(installation, "image", "apko.lock.json")));
    for (const file of [
      "mise.lock",
      ".trivyignore.yaml",
      ".mise/locks/npm-typescript/7.0.2/aube-lock.yaml",
      ".mise/locks/npm-typescript/7.0.2/package.json",
    ])
      assert.equal(
        readFileSync(join(installation, file), "utf8"),
        readFileSync(join(ROOT, file), "utf8"),
      );
    assert.ok(!existsSync(join(installation, ".env")));
    assert.ok(!existsSync(join(installation, "node_modules")));
    assert.ok(!readFileSync(shim, "utf8").includes(ROOT));
    const git = spawnSync(
      shim,
      ["run", "--name", "test", "--git", "--exec", "true"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.notEqual(git.status, 0);
    assert.match(git.stderr, /No Git checkout found/);
    // Reinstall from a new source path; the installed shim stays valid.
    install(join(root, "moved-source"), installation);
    writeFileSync(shim, "unrelated command\n");
    assert.throws(() => install(ROOT, installation), /existing command/);
    assert.equal(readFileSync(shim, "utf8"), "unrelated command\n");
    const unrelated = join(root, "unrelated");
    mkdirSync(unrelated);
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, "scripts", "install.ts"),
        "--bin-dir",
        join(root, "other-bin"),
        "--install-dir",
        unrelated,
      ],
      { env, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrelated directory/);
    assert.ok(!existsSync(join(unrelated, ".agent-sandbox-install")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
