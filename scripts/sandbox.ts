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
export const PROFILES = ["base", "codex", "opencode", "claude"] as const;
export type Agent = "codex" | "opencode" | "claude";
export const DEFAULT_DNS = process.env.CONTAINER_DNS ?? "1.1.1.1";
const LABEL = "dev.agent-container.managed";
const LEGACY_LABEL = "dev.codex-sandbox.managed";
const HERDR_LABEL = "dev.agent-container.herdr";

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

function agentStateHome(home: string, agent: Agent): string {
  return join(home, ".local", "share", "agent-container", agent, "home");
}

export function mountPlan(
  checkout: string,
  home: string,
  agent?: Agent,
): Map<string, boolean> {
  const mounts = new Map(
    repositoryMounts(checkout).map((path) => [path, false]),
  );
  if (agent === "codex") {
    const codex = join(home, ".codex");
    if (!existsSync(codex))
      throw new Error(`Missing Codex directory: ${codex}`);
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
  }
  if (agent === "opencode" || agent === "claude") {
    const state = agentStateHome(home, agent);
    for (let path = state; path !== home; path = dirname(path)) {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new Error(
          `A persistent home cannot use symlinked ancestors: ${path}`,
        );
    }
    mkdirSync(state, { recursive: true });
    mounts.set(state, false);
  }
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
function requireName(name: string, existing = false): string {
  if (
    !(existing ? /^(?:ac|cs)-[a-z0-9-]{1,50}$/ : /^ac-[a-z0-9-]{1,50}$/).test(
      name,
    )
  )
    throw new Error(
      "Names must start with ac- and use lowercase letters, digits, hyphens",
    );
  return name;
}
export type Options = {
  checkout?: string;
  home?: string;
  name?: string;
  image?: string;
  cpus?: string;
  memory?: string;
  dns?: string;
  agent?: Agent;
  herdr: boolean;
  engine?: string;
  profile?: string;
  prompt?: string;
};

export function start(options: Options): { name: string; checkout: string } {
  const checkout = checkoutRoot(resolve(options.checkout ?? process.cwd()));
  const home = realpathSync(options.home ?? homedir());
  const mounts = mountPlan(checkout, home, options.agent);
  const container = executable("container");
  const name = requireName(options.name ?? `ac-${randomUUID().slice(0, 10)}`);
  if (options.herdr) {
    executable("hc");
    const machines = JSON.parse(run("hc", ["machine", "ls", "--json"]));
    if (
      machines.machines.some(
        (machine: { name: string }) => machine.name === name,
      )
    )
      throw new Error(`hc machine name already exists: ${name}`);
  }
  const guestHome =
    options.agent === "codex"
      ? home
      : options.agent
        ? agentStateHome(home, options.agent)
        : "/root";
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `${LABEL}=true`,
    "--label",
    `${HERDR_LABEL}=${options.herdr}`,
    "--cpus",
    options.cpus ?? "4",
    "--memory",
    options.memory ?? "4G",
    "--workdir",
    checkout,
    "--env",
    `HOME=${guestHome}`,
    "--env",
    "AGENT_BROWSER_SOCKET_DIR=/tmp/agent-browser",
    "--dns",
    options.dns ?? DEFAULT_DNS,
  ];
  if (options.agent === "codex")
    args.push("--env", `CODEX_HOME=${join(home, ".codex")}`);
  console.error(`Starting ${name}; host mounts:`);
  for (const [path, readonly] of mounts) {
    if (/[:,\n]/.test(path))
      throw new Error(`Unsupported mount path delimiter: ${path}`);
    args.push("--volume", `${path}:${path}${readonly ? ":ro" : ""}`);
    console.error(`  ${readonly ? "ro" : "rw"} ${path}`);
  }
  run(container, [
    ...args,
    options.image ?? `agent-container:${options.agent ?? "base"}`,
  ]);
  try {
    run(container, ["exec", name, "mkdir", "-p", guestHome]);
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
    const skills = join(home, ".agents", "skills");
    if (guestHome !== home && existsSync(skills)) {
      run(container, ["exec", name, "mkdir", "-p", join(guestHome, ".agents")]);
      run(container, [
        "exec",
        name,
        "ln",
        "-sfn",
        skills,
        join(guestHome, ".agents", "skills"),
      ]);
    }
    if (options.herdr) {
      const via = [container, "exec", "-i", name, "sh", "-c"]
        .map(quote)
        .join(" ");
      run("hc", ["machine", "add", "--name", name, "--via", via]);
    }
  } catch (error) {
    // Registration is the last operation; a failed add must not remove an existing machine.
    run(container, ["delete", "--force", name]);
    throw error;
  }
  return { name, checkout };
}

export function stop(name: string): void {
  requireName(name, true);
  const info = JSON.parse(run("container", ["inspect", name]));
  if (
    info[0].configuration.labels?.[LABEL] !== "true" &&
    info[0].configuration.labels?.[LEGACY_LABEL] !== "true"
  )
    throw new Error(`Guest is not owned by this launcher: ${name}`);
  try {
    if (
      info[0].configuration.labels?.[HERDR_LABEL] === "true" ||
      info[0].configuration.labels?.[LEGACY_LABEL] === "true"
    )
      run("hc", ["machine", "rm", name]);
  } finally {
    run("container", ["delete", "--force", name]);
  }
}

function build(options: Options): void {
  execFileSync("node", [join(ROOT, "scripts", "check-locks.ts")], {
    stdio: "inherit",
  });
  const engine = options.engine ?? "container";
  const variant = options.profile ?? "base";
  if (!(PROFILES as readonly string[]).includes(variant))
    throw new Error("Use --profile base|codex|opencode|claude");
  const args = [
    "build",
    "--pull",
    "--tag",
    options.image ?? `agent-container:${variant}`,
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
    "OPENCODE_VERSION",
    "CLAUDE_VERSION",
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

async function foreground(command: string, argv: string[]): Promise<number> {
  return await new Promise((done, reject) => {
    const child = spawn(command, argv, { stdio: "inherit" });
    const interrupt = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.once("error", reject);
    child.once("close", (code) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      done(code ?? 1);
    });
  });
}

async function workload(
  name: string,
  checkout: string,
  argv: string[],
  herdr: boolean,
): Promise<number> {
  if (!herdr)
    return foreground("container", [
      "exec",
      process.stdin.isTTY && process.stdout.isTTY ? "-it" : "-i",
      name,
      ...argv,
    ]);
  const id = randomUUID().slice(0, 8);
  run("hc", [
    "run",
    "--bg",
    "--on",
    name,
    "--name",
    "agent",
    "--cwd",
    checkout,
    "--no-parent",
    "--outlive-parent",
    "--label",
    `herdr.space=sp${id}`,
    "--label",
    `herdr.tab=tb${id}`,
    "--",
    ...argv,
  ]);
  // Herdr adopts unknown space/tab IDs without changing the selected session.
  const code = await foreground("hc", ["attach", `${name}/agent`]);
  const terminal = JSON.parse(run("hc", ["get", "--json", `${name}/agent`]));
  return terminal.finished_ms !== null ? (terminal.exit_code ?? 1) : code;
}

export function parseInvocation(input: string[]) {
  let args = [...input];
  let command = "run";
  if (
    ["build", "scan", "start", "stop", "shell", "attach", "status"].includes(
      args[0],
    )
  )
    command = args.shift()!;
  if (args[0] === "exec")
    throw new Error("Use --exec COMMAND ARG... instead of an exec subcommand");
  let name: string | undefined;
  if (["stop", "shell", "attach"].includes(command))
    name = requireName(args.shift() ?? "", true);
  let custom: string[] | undefined;
  const flags: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--exec") {
      custom = args.slice(index + 1);
      if (!custom.length) throw new Error("--exec requires a command");
      break;
    }
    if (args[index] === "--prompt") {
      if (args[index + 1] === undefined)
        throw new Error("--prompt requires text");
      flags.push(`--prompt=${args[++index]}`);
    } else flags.push(args[index]);
  }
  args = flags;
  const names = [
    "engine",
    "image",
    "checkout",
    "home",
    "name",
    "cpus",
    "memory",
    "dns",
    "profile",
    "agent",
    "prompt",
  ];
  const { values } = parseArgs({
    args,
    options: {
      ...Object.fromEntries(
        names.map((name) => [name, { type: "string" as const }]),
      ),
      herdr: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) command = "help";
  const options = values as Options;
  if (options.agent && !["codex", "opencode", "claude"].includes(options.agent))
    throw new Error(`Unknown agent: ${options.agent}`);
  if (options.prompt !== undefined && !options.agent)
    throw new Error("--prompt requires --agent");
  if (options.prompt !== undefined && custom)
    throw new Error("--prompt cannot combine with --exec");
  if (options.engine && !["container", "docker"].includes(options.engine))
    throw new Error("Engine must be container or docker");
  if (options.engine === "docker" && !["build", "scan"].includes(command))
    throw new Error("Guest launches use Apple's container runtime");
  if (!["run"].includes(command) && custom)
    throw new Error("--exec is only supported when launching a workload");
  let argv = custom ?? ["bash"];
  if (!custom && options.agent) {
    argv =
      options.agent === "codex"
        ? [
            "codex",
            "--no-daemon",
            "--dangerously-bypass-approvals-and-sandbox",
            "-c",
            'cli_auth_credentials_store="file"',
          ]
        : options.agent === "opencode"
          ? ["opencode", "--standalone"]
          : ["claude"];
    if (options.prompt !== undefined)
      argv.push(
        ...(options.agent === "opencode"
          ? [`--prompt=${options.prompt}`]
          : ["--", options.prompt]),
      );
  }
  return { command, options, argv, name };
}

async function main(): Promise<void> {
  const {
    command,
    options,
    argv,
    name: existing,
  } = parseInvocation(process.argv.slice(2));
  if (command === "help") {
    console.log(`Usage: agent-container [options] [--exec COMMAND ARG...]
Bare invocation opens a shell in the browser-equipped base image.
  --agent codex|opencode|claude    Select agent image, state and default command
  --prompt TEXT                  Interactive initial prompt; requires --agent
  --herdr                        Create a background Herdr session; keep current selection
  --exec COMMAND ARG...          Literal custom command; consumes remaining arguments
  --checkout PATH --home PATH --name ac-NAME --image TAG --dns IP --cpus N --memory 4G
Commands: build [--profile base|codex|opencode|claude], scan, start, stop NAME, shell NAME, attach NAME, status
Build/scan: --engine container|docker. start retains a guest until stop.
Launch options precede --exec. Use --exec sh -lc '...' for shell syntax.`);
    return;
  }
  if (command === "status") {
    for (const item of JSON.parse(
      run("container", ["ls", "--all", "--format", "json"]),
    ))
      if (
        item.configuration.labels?.[LABEL] === "true" ||
        item.configuration.labels?.[LEGACY_LABEL] === "true"
      )
        console.log(`${item.configuration.id}\t${item.status}`);
    return;
  }
  if (command === "stop") {
    stop(existing!);
    return;
  }
  if (command === "shell" || command === "attach") {
    process.exitCode =
      command === "shell"
        ? await foreground("container", ["exec", "-it", existing!, "bash"])
        : await foreground("hc", ["attach", `${existing}/agent`]);
    return;
  }
  if (command === "build") {
    build(options);
    return;
  }
  if (command === "scan") {
    scan(
      options.engine ?? "container",
      options.image ??
        `agent-container:${options.agent ?? options.profile ?? "base"}`,
    );
    return;
  }
  if (
    command === "run" &&
    options.herdr &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error(
      "--herdr workloads require interactive stdin and stdout; omit --herdr for piped input or redirected output",
    );
  const { name, checkout } = start(options);
  if (command === "start") {
    console.log(name);
    console.error(`Stop with: agent-container stop ${name}`);
    return;
  }
  try {
    process.exitCode = await workload(name, checkout, argv, options.herdr);
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
