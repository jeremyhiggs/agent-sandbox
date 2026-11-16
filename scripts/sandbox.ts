import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkVulnerabilities } from "./vulnerabilities.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const IMAGE = "codex-sandbox:local";
export const DEFAULT_DNS = process.env.CONTAINER_DNS ?? "1.1.1.1";
const LABEL = "dev.codex-sandbox.managed";

export function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
}
function inside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + sep);
}
function file(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile();
}
function pointer(path: string): string {
  return resolve(dirname(path), readFileSync(path, "utf8").trim());
}

function directory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function gitMetadata(path: string): string {
  const canonical = realpathSync(path);
  if (
    !file(join(canonical, "HEAD")) ||
    !directory(join(canonical, "objects")) ||
    !(
      directory(join(canonical, "refs")) || file(join(canonical, "packed-refs"))
    )
  ) {
    throw new Error(`Invalid Git metadata directory: ${path}`);
  }
  return canonical;
}

function jjRepository(path: string): string {
  const canonical = realpathSync(path);
  if (
    !file(join(canonical, "store", "type")) ||
    !file(join(canonical, "op_store", "type")) ||
    !directory(join(canonical, "op_heads"))
  ) {
    throw new Error(`Invalid JJ repository directory: ${path}`);
  }
  return canonical;
}

export function repositoryMounts(checkout: string): string[] {
  const mounts = new Set([realpathSync(checkout)]);
  let git = join(checkout, ".git");
  if (file(git)) {
    const text = readFileSync(git, "utf8").trim();
    if (!text.startsWith("gitdir: "))
      throw new Error(`Unrecognized Git pointer: ${git}`);
    git = resolve(checkout, text.slice(8));
    const backlink = join(git, "gitdir");
    if (!file(backlink) || pointer(backlink) !== join(checkout, ".git")) {
      throw new Error(
        `Git metadata is not registered to this worktree: ${git}`,
      );
    }
    mounts.add(
      gitMetadata(
        file(join(git, "commondir")) ? pointer(join(git, "commondir")) : git,
      ),
    );
  }
  let jj = join(checkout, ".jj", "repo");
  if (file(jj)) {
    jj = jjRepository(pointer(jj));
    mounts.add(jj);
  } else if (existsSync(jj) && lstatSync(jj).isSymbolicLink()) {
    jj = jjRepository(jj);
    mounts.add(jj);
  }
  const target = join(jj, "store", "git_target");
  if (file(target)) mounts.add(gitMetadata(pointer(target)));
  return [...mounts].sort();
}

function directSymlinkTarget(path: string): string {
  const target = resolve(dirname(path), readlinkSync(path));
  const canonical = realpathSync(path);
  if (target !== canonical)
    throw new Error(
      `Unsupported chained symlink: ${path}; use a direct canonical target`,
    );
  return target;
}

export function withSymlinkTargets(paths: string[], home?: string): string[] {
  const mounts = new Set<string>();
  function visit(path: string, mount: boolean) {
    if (home && inside(home, path))
      throw new Error(`Refusing a mount that exposes host home: ${path}`);
    if (mounts.has(path)) return;
    if (mount) mounts.add(path);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) visit(directSymlinkTarget(path), true);
    else if (info.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink() && existsSync(child))
          visit(directSymlinkTarget(child), true);
        else if (entry.isDirectory()) visit(child, false);
      }
    }
  }
  for (const path of paths) visit(path, true);
  return [...mounts].sort();
}

export function mountPlan(
  checkout: string,
  home: string,
): Map<string, boolean> {
  const mounts = new Map(
    repositoryMounts(checkout).map((path) => [path, false]),
  );
  const codex = join(home, ".codex");
  if (!existsSync(codex)) throw new Error(`Missing Codex directory: ${codex}`);
  if (lstatSync(codex).isSymbolicLink())
    throw new Error(
      `Codex directory cannot be a symlink in this initial version: ${codex}`,
    );
  mounts.set(codex, false);
  for (const name of ["config.toml", "auth.json"]) {
    const path = join(codex, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      const target = directSymlinkTarget(path);
      if (![checkout, codex].some((root) => inside(target, root))) {
        throw new Error(
          `${name} requires a shared directory for atomic updates; its symlink target is outside the checkout and Codex directory`,
        );
      }
    }
  }
  const codexContent = [
    "skills",
    "plugins",
    "config.toml",
    "auth.json",
    "AGENTS.md",
  ]
    .map((name) => join(codex, name))
    .filter(existsSync);
  for (const path of withSymlinkTargets(codexContent, home))
    mounts.set(path, false);
  const skills = join(home, ".agents", "skills");
  if (existsSync(skills)) {
    for (const path of withSymlinkTargets([skills], home))
      mounts.set(path, true);
  }
  const plan = new Map<string, boolean>();
  for (let [path, readonly] of [...mounts.entries()].sort(
    ([a], [b]) => a.length - b.length,
  )) {
    if (inside(home, path))
      throw new Error(`Refusing to expose host home: ${path}`);
    const inherited = [...plan.entries()]
      .filter(([parent]) => inside(path, parent))
      .at(-1)?.[1];
    readonly ||= inherited === true;
    if (inherited !== readonly) plan.set(path, readonly);
  }
  return plan;
}

export function checkoutRoot(path: string): string {
  let current = realpathSync(path);
  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, ".jj")))
      return current;
    const parent = dirname(current);
    if (parent === current)
      throw new Error(`No Git or JJ checkout found at ${path}`);
    current = parent;
  }
}
function executable(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return resolve(path);
    } catch {}
  }
  throw new Error(`Required host command not found: ${name}`);
}
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function requireName(name: string): string {
  if (!/^cs-[a-z0-9-]{1,50}$/.test(name))
    throw new Error(
      "Names must start with cs- and use lowercase letters, digits, hyphens",
    );
  return name;
}
type Options = {
  checkout?: string;
  home?: string;
  name?: string;
  image?: string;
  cpus?: string;
  memory?: string;
  dns?: string;
};

export function start(options: Options): { name: string; checkout: string } {
  const checkout = checkoutRoot(resolve(options.checkout ?? process.cwd()));
  const home = realpathSync(options.home ?? homedir());
  const mounts = mountPlan(checkout, home);
  const container = executable("container");
  executable("hc");
  const name = requireName(options.name ?? `cs-${randomUUID().slice(0, 10)}`);
  const machines = JSON.parse(run("hc", ["machine", "ls", "--json"])) as {
    machines: { name: string }[];
  };
  if (machines.machines.some((machine) => machine.name === name))
    throw new Error(`hc machine name already exists: ${name}`);
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `${LABEL}=true`,
    "--cpus",
    options.cpus ?? "4",
    "--memory",
    options.memory ?? "4G",
    "--workdir",
    checkout,
    "--env",
    `HOME=${home}`,
    "--env",
    `CODEX_HOME=${join(home, ".codex")}`,
    "--env",
    "XDG_STATE_HOME=/var/lib",
    "--env",
    "XDG_CONFIG_HOME=/etc/xdg",
    "--env",
    "AGENT_BROWSER_SOCKET_DIR=/tmp/agent-browser",
  ];
  args.push("--dns", options.dns ?? DEFAULT_DNS);
  console.error(`Starting ${name}; host mounts:`);
  for (const [path, readonly] of mounts) {
    if (/[:,\n]/.test(path))
      throw new Error(`Unsupported mount path delimiter: ${path}`);
    args.push("--volume", `${path}:${path}${readonly ? ":ro" : ""}`);
    console.error(`  ${readonly ? "ro" : "rw"} ${path}`);
  }
  run(container, [...args, options.image ?? IMAGE]);
  try {
    run(container, [
      "exec",
      name,
      "git",
      "config",
      "--global",
      "--add",
      "safe.directory",
      checkout,
    ]);
    const via = [container, "exec", "-i", name, "sh", "-c"]
      .map(quote)
      .join(" ");
    run("hc", ["machine", "add", "--name", name, "--via", via]);
  } catch (error) {
    try {
      run("hc", ["machine", "rm", name]);
    } catch {}
    run(container, ["delete", "--force", name]);
    throw error;
  }
  return { name, checkout };
}

export function stop(name: string): void {
  requireName(name);
  const info = JSON.parse(run("container", ["inspect", name]));
  if (info[0].configuration.labels?.[LABEL] !== "true")
    throw new Error(`Guest is not owned by this launcher: ${name}`);
  try {
    run("hc", ["machine", "rm", name]);
  } finally {
    run("container", ["delete", "--force", name]);
  }
}

function build(options: Record<string, string | undefined>): void {
  execFileSync("node", [join(ROOT, "scripts", "check-locks.ts")], {
    stdio: "inherit",
  });
  const engine = options.engine ?? "container";
  const variant = options.variant ?? "base";
  if (!["base", "browser"].includes(variant))
    throw new Error("Use --variant base|browser");
  const args = [
    "build",
    "--pull",
    "--no-cache",
    "--tag",
    options.image ?? IMAGE,
    "--target",
    variant,
  ];
  for (const name of [
    "WOLFI_BASE",
    "MISE_BASE",
    "BROWSER_SHA256_ARM64",
    "BROWSER_SHA256_AMD64",
    "PNPM_VERSION",
    "BROWSER_VERSION",
    "CODEX_VERSION",
    "AGENT_BROWSER_VERSION",
    "HC_VERSION",
    "JJ_VERSION",
  ]) {
    const value = process.env[`IMAGE_${name}`];
    if (!value) throw new Error(`Missing IMAGE_${name}; run through mise`);
    args.push("--build-arg", `${name}=${value}`);
  }
  if (engine === "container") args.push("--dns", options.dns ?? DEFAULT_DNS);
  else if (options.dns)
    throw new Error("Build --dns is supported only by Apple's runtime");
  execFileSync(engine, [...args, ROOT], { stdio: "inherit" });
}

function scan(engine: string, image: string): void {
  const artifacts = join(ROOT, ".artifacts");
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), "codex-image-"));
  try {
    const archive = join(temp, "image.tar");
    run(engine, ["image", "save", "--output", archive, image]);
    let input = archive;
    if (engine === "container") {
      // Apple exports an OCI tar; Trivy expects an unpacked OCI layout.
      input = join(temp, "oci");
      mkdirSync(input);
      run("tar", ["-xf", archive, "-C", input]);
      rmSync(archive);
    }
    const report = join(
      artifacts,
      `vulnerabilities-${image.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`,
    );
    run("trivy", [
      "image",
      "--input",
      input,
      "--scanners",
      "vuln",
      "--format",
      "json",
      "--output",
      report,
      "--exit-code",
      "0",
    ]);
    checkVulnerabilities(report);
  } finally {
    rmSync(temp, { recursive: true });
  }
}

async function attachedCodex(
  name: string,
  checkout: string,
  extra: string[],
): Promise<number> {
  run("hc", [
    "run",
    "--bg",
    "--on",
    name,
    "--name",
    "codex",
    "--cwd",
    checkout,
    "--no-parent",
    "--outlive-parent",
    "--",
    "codex",
    "--no-daemon",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    'cli_auth_credentials_store="file"',
    ...extra,
  ]);
  return await new Promise((done, reject) => {
    const child = spawn("hc", ["attach", `${name}/codex`], {
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.once("error", reject);
    child.once("close", (code) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      try {
        const terminal = JSON.parse(
          run("hc", ["get", "--json", `${name}/codex`]),
        ) as {
          finished_ms: number | null;
          exit_code: number | null;
        };
        if (terminal.finished_ms !== null) {
          if (code !== 0)
            process.stdout.write(run("hc", ["read", `${name}/codex`]));
          done(terminal.exit_code ?? 1);
        } else done(code ?? 1);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function parseOptions(command: string, args: string[]) {
  const names = [
    "engine",
    "image",
    "checkout",
    "home",
    "name",
    "cpus",
    "memory",
    "dns",
    "variant",
  ];
  let split = args.indexOf("--");
  if (command === "run" && split < 0) {
    split = args.length;
    for (let index = 0; index < args.length; index++) {
      const option = args[index].split("=", 1)[0].replace(/^--/, "");
      if (!args[index].startsWith("--") || !names.includes(option)) {
        split = index;
        break;
      }
      if (!args[index].includes("=")) index++;
    }
  }
  const extra =
    split >= 0 ? args.slice(split + (args[split] === "--" ? 1 : 0)) : [];
  const { values } = parseArgs({
    args: split >= 0 ? args.slice(0, split) : args,
    options: Object.fromEntries(
      names.map((name) => [name, { type: "string" as const }]),
    ),
  });
  return { values: { ...values }, extra };
}

async function main(): Promise<void> {
  const [requested, ...args] = process.argv.slice(2);
  const command = requested === "codex" ? "run" : requested;
  if (command === "browser") {
    execFileSync(
      "container",
      ["exec", requireName(args[0]), "node", "/opt/codex-container/browser.ts"],
      { stdio: "inherit" },
    );
    return;
  }
  if (command === "status") {
    const containers = JSON.parse(
      run("container", ["ls", "--all", "--format", "json"]),
    );
    for (const item of containers) {
      if (item.configuration.labels?.[LABEL] === "true")
        console.log(`${item.configuration.id}\t${item.status}`);
    }
    return;
  }
  if (command === "shell" || command === "attach") {
    const name = requireName(args[0]);
    const program = command === "shell" ? "container" : "hc";
    const argv =
      command === "shell"
        ? ["exec", "-it", name, "bash"]
        : ["attach", `${name}/codex`];
    execFileSync(program, argv, { stdio: "inherit" });
    return;
  }
  if (command === "stop") {
    stop(args[0]);
    return;
  }
  if (!["build", "scan", "start", "run"].includes(command)) {
    console.log(
      "Usage: codex-container <build|scan|start|codex|stop|shell|attach|browser|status> [options]\nOptions: --checkout PATH --name cs-NAME --home PATH --image TAG --dns IP --cpus N --memory 4G\nBuild: --variant base|browser\nCodex arguments follow --. Stop/shell/attach/browser take a guest name.",
    );
    if (command && command !== "--help") process.exitCode = 1;
    return;
  }
  const { values, extra } = parseOptions(command, args);
  const engine = values.engine ?? "container";
  if (!["container", "docker"].includes(engine))
    throw new Error("Engine must be container or docker");
  if (command === "build") {
    build(values);
    return;
  }
  if (command === "scan") {
    scan(engine, values.image ?? IMAGE);
    return;
  }
  const { name, checkout } = start(values);
  console.log(name);
  if (command === "start") {
    console.error(
      `Stop with: codex-container stop ${name} (or mise run stop ${name} in the launcher repo)`,
    );
    return;
  }
  try {
    process.exitCode = await attachedCodex(name, checkout, extra);
  } finally {
    stop(name);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
