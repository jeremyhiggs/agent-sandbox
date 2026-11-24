import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const name = "nested-smoke-" + randomUUID().slice(0, 8);
const launcher = join(import.meta.dirname, "sandbox.ts");
const image = process.argv[2] ?? "agent-sandbox:base";
const sentinel = "nested-image-built";
const innerImage = "localhost/nested-smoke:built";
const standalonePort = 18080;
const composePort = 18081;

function sandbox(args: string[], input?: string): string {
  return execFileSync(
    process.execPath,
    [launcher, args[0], "--name", name, ...args.slice(1)],
    { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] },
  ).trim();
}

function guest(...args: string[]): string {
  return sandbox(["shell", "--exec", ...args]);
}

async function loopbackPorts() {
  const servers = [createServer(), createServer()];
  try {
    return await Promise.all(
      servers.map(
        (server) =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () =>
              resolve((server.address() as AddressInfo).port),
            );
          }),
      ),
    );
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
}

async function verifyHTTP(hostPort: number, guestPort: number) {
  const hostURL = `http://127.0.0.1:${hostPort}/`;
  const guestURL = `http://127.0.0.1:${guestPort}/`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(hostURL, {
        signal: AbortSignal.timeout(1000),
      });
      assert.ok(response.ok, `${hostURL} returned ${response.status}`);
      assert.equal((await response.text()).trim(), sentinel);
      assert.equal(
        guest("curl", "-fsS", "--max-time", "3", guestURL),
        sentinel,
      );
      console.log(
        `Guest ${guestURL} and macOS ${hostURL} both returned the build sentinel`,
      );
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(250);
    }
  }
}

const fixture = String.raw`
set -eu
cat > Dockerfile <<'EOF'
FROM docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd
RUN mkdir /www && printf '%s\n' '${sentinel}' > /www/index.html
COPY serve /www/serve
CMD ["nc", "-lk", "-p", "8080", "-e", "/www/serve"]
EOF
cat > serve <<'EOF'
#!/bin/sh
while IFS= read -r line; do
  [ "$line" != "$(printf '\r')" ] || break
done
printf 'HTTP/1.0 200 OK\r\nConnection: close\r\n\r\n'
exec cat /www/index.html
EOF
chmod 0755 serve
cat > compose.yaml <<'EOF'
services:
  web:
    image: ${innerImage}
    ports:
      - "${composePort}:8080"
  client:
    image: ${innerImage}
    command: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"]
EOF
podman build --tag ${innerImage} .
podman run --pull=never --detach --name standalone --publish ${standalonePort}:8080 ${innerImage}
podman-compose up -d
`;

const [hostStandalone, hostCompose] = await loopbackPorts();
const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-nested-")));
const checkout = join(root, "checkout");
const worktree = join(root, "worktree");
const home = join(root, "home");
const codex = join(home, ".codex");
const auth = join(codex, "auth.json");
const skills = join(home, ".agents", "skills");
const reference = join(root, "reference");
const authFixture = '{"smoke":true}\n';
let created = false;
try {
  for (const dir of [codex, skills, reference])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(auth, authFixture, { mode: 0o600 });
  writeFileSync(join(codex, "host-only"), "private fixture");
  writeFileSync(join(skills, "fixture.md"), "read-only skill");
  writeFileSync(join(reference, "fixture.txt"), "read-only reference");
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "worktree",
    "add",
    "--orphan",
    "-qb",
    "nested-smoke",
    worktree,
  ]);
  sandbox([
    "run",
    "--image",
    image,
    "--mount-git",
    worktree,
    "--git-name",
    "Sandbox Smoke",
    "--git-email",
    "smoke@example.invalid",
    "--home",
    home,
    "--mount-codex-auth",
    "--mount-skills",
    "--volume",
    `${reference}:/reference:ro`,
    "--cpus",
    "2",
    "--memory",
    "2G",
    "--publish",
    `${hostStandalone}:${standalonePort}`,
    "--publish",
    `${hostCompose}:${composePort}`,
    "--exec",
    "true",
  ]);
  created = true;
  assert.equal(guest("id", "-u"), "1000");
  assert.equal(guest("git", "rev-parse", "--show-toplevel"), worktree);
  assert.equal(guest("cat", auth), authFixture.trim());
  assert.equal(guest("cat", join(skills, "fixture.md")), "read-only skill");
  guest("test", "!", "-e", join(codex, "host-only"));
  guest(
    "sh",
    "-ec",
    'if (printf forbidden >> "$1") 2>/dev/null; then echo "Codex auth mount allowed a write" >&2; exit 1; fi',
    "verify-auth",
    auth,
  );
  guest("touch", join(codex, "guest-only"));
  assert.equal(
    guest(
      "podman",
      "info",
      "--format",
      "{{.Host.Security.Rootless}} {{.Store.GraphDriverName}}",
    ),
    "true overlay",
  );
  console.log(sandbox(["shell", "--exec", "sh", "-s"], fixture));
  assert.equal(
    guest(
      "podman",
      "run",
      "--rm",
      "--pull=never",
      "--volume",
      `${worktree}:/work:rw`,
      "--volume",
      "/reference:/input:ro",
      innerImage,
      "sh",
      "-ec",
      "cat /input/fixture.txt > /work/inner-output; if touch /input/forbidden 2>/dev/null; then exit 1; fi; cat /work/inner-output",
    ),
    "read-only reference",
  );
  assert.equal(
    readFileSync(join(worktree, "inner-output"), "utf8"),
    "read-only reference",
  );
  assert.equal(readFileSync(auth, "utf8"), authFixture);
  console.log(
    "Linked worktree, scoped auth and skills mounts, and inner read-only/read-write binds passed",
  );
  await verifyHTTP(hostStandalone, standalonePort);
  await verifyHTTP(hostCompose, composePort);
  assert.equal(
    guest(
      "podman-compose",
      "exec",
      "-T",
      "client",
      "wget",
      "-qO-",
      "http://web:8080/",
    ),
    sentinel,
  );
  console.log("Compose service DNS and HTTP passed");
  guest("podman-compose", "down");
  guest("podman", "rm", "--force", "standalone");
  sandbox(["stop"]);
  sandbox(["start", "--exec", "true"]);
  assert.equal(
    guest(
      "podman",
      "run",
      "--pull=never",
      "--rm",
      innerImage,
      "cat",
      "/www/index.html",
    ),
    sentinel,
  );
  console.log("Rootless Podman image survived the sandbox restart");
} finally {
  try {
    if (created) sandbox(["delete"]);
  } finally {
    rmSync(root, { recursive: true });
  }
}
