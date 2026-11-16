import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

for (const tool of [
  "mise",
  "node",
  "git",
  "codex",
  "agent-browser",
  "hc",
  "jj",
]) {
  execFileSync(tool, ["--version"], { stdio: "inherit" });
}
try {
  execFileSync(
    "agent-browser",
    [
      "open",
      "data:text/html,<title>Container smoke test</title><h1>Ready</h1>",
    ],
    { stdio: "inherit" },
  );
  const title = execFileSync("agent-browser", ["get", "title"], {
    encoding: "utf8",
  }).trim();
  assert.equal(title, "Container smoke test");
} finally {
  execFileSync("agent-browser", ["close"], { stdio: "inherit" });
}
console.log("Image tool and browser checks passed");
