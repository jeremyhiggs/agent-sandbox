import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, run } from "./sandbox.ts";

type Space = {
  id: string;
  active: boolean;
  tabs: { id: string; active: boolean; terminals: unknown[] }[];
};
const snapshot = (): { spaces: Space[] } =>
  JSON.parse(run("herdr-app", ["ls"]));
function selection(value: { spaces: Space[] }) {
  const space = value.spaces.find((space) => space.active);
  return [space?.id, space?.tabs.find((tab) => tab.active)?.id];
}
const before = selection(snapshot());
const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-herdr-")));
const home = join(root, "home"),
  work = join(root, "work");
const name = `as-app-smoke-${process.pid}`;
const cli = (args: string[]) =>
  run(process.execPath, [join(ROOT, "scripts", "sandbox.ts"), ...args]);
let created = false;
async function until<T>(
  find: (value: { spaces: Space[] }) => T | undefined | false,
): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = find(snapshot());
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Herdr adoption did not complete within five seconds");
}
try {
  mkdirSync(home);
  mkdirSync(work);
  run("git", ["init", "-q", work]);
  const guests = JSON.parse(
    run("container", ["ls", "--all", "--format", "json"]),
  );
  assert.ok(
    !guests.some(
      (guest: { configuration: { id: string } }) =>
        guest.configuration.id === name,
    ),
    "Test sandbox name already exists",
  );
  created = true;
  cli([
    "run",
    "--name",
    name,
    "--checkout",
    work,
    "--home",
    home,
    "--herdr",
    "--detach",
    "--terminal",
    "first",
    "--exec",
    "bash",
  ]);
  const labels = JSON.parse(run("container", ["inspect", name]))[0]
    .configuration.labels;
  const space = await until((value) =>
    value.spaces.find(
      (space) =>
        space.id === name + "/" + labels["dev.agent-container.herdr-space"],
    ),
  );
  assert.deepEqual(
    selection(snapshot()),
    before,
    "Creation changed the selected session",
  );
  const tab = space.tabs.find((tab) => tab.terminals.length);
  assert.ok(tab);
  const count = tab.terminals.length;
  cli([
    "shell",
    "--name",
    name,
    "--herdr-space",
    space.id,
    "--herdr-tab",
    tab.id,
    "--detach",
    "--terminal",
    "second",
    "--exec",
    "bash",
  ]);
  await until(
    (value) =>
      (value.spaces
        .find((item) => item.id === space.id)
        ?.tabs.find((item) => item.id === tab.id)?.terminals.length ?? 0) >
      count,
  );
  assert.deepEqual(
    selection(snapshot()),
    before,
    "Joining the existing tab changed selection",
  );
  console.log(
    "Two guest terminals joined the same Herdr space/tab; selected session preserved",
  );
} finally {
  if (created) {
    const guests = JSON.parse(
      run("container", ["ls", "--all", "--format", "json"]),
    );
    const guest = guests.find(
      (guest: { configuration: { id: string } }) =>
        guest.configuration.id === name,
    );
    if (guest) {
      assert.equal(
        guest.configuration.labels["dev.agent-container.checkout"],
        realpathSync(work),
        "Refusing to delete a sandbox from another test",
      );
      cli(["delete", "--name", name]);
    }
  }
  rmSync(root, { recursive: true, force: true });
}
