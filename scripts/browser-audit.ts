import assert from "node:assert/strict";

const endpoint =
  "https://chromereleases.googleblog.com/feeds/posts/default/-/Desktop%20Update/Stable%20updates";

type Advisory = { id: string; severity: string; issue?: string };
type Release = { version: string; url: string; advisories: Advisory[] };
type Feed = {
  feed: {
    entry: { content: { $t: string }; link: { rel: string; href: string }[] }[];
    link: { rel: string }[];
  };
};

function compareVersions(left: string, right: string): number {
  const parts = right.split(".").map(Number);
  for (const [index, part] of left.split(".").entries()) {
    const difference = Number(part) - parts[index];
    if (difference) return difference;
  }
  return 0;
}

export function chromeRelease(html: string, url: string): Release | undefined {
  const text = html.replace(/<[^>]*>|&nbsp;|&#160;/gi, " ");
  const intro = text.split(/Security Fixes and Rewards/i, 1)[0];
  const versions = new Set(intro.match(/\b\d+\.\d+\.\d+\.\d+\b/g));
  const version =
    intro.match(
      /\b(\d+\.\d+\.\d+\.\d+)\s*(?:\(Linux\)|(?:for|to)\s+Linux\b)/i,
    )?.[1] ??
    (/\bLinux\b/i.test(intro) && versions.size === 1
      ? versions.values().next().value
      : undefined);
  if (!version) return undefined;

  const advisories: Advisory[] = [];
  for (const [, issueId, severity, cve] of text.matchAll(
    /(?:\[\s*(\d+)\s*\]\s*)?\b(low|medium|moderate|high|critical)\b(?:\s+(CVE-\d{4}-\d{4,})\b)?/gi,
  )) {
    const issue = issueId ? `Chromium issue ${issueId}` : undefined;
    const id = cve?.toUpperCase() ?? issue;
    if (id) advisories.push({ id, severity: severity.toLowerCase(), issue });
  }
  return { version, url, advisories };
}

export function browserReport(pinned: string, releases: Release[]) {
  assert.match(pinned, /^\d+\.\d+\.\d+\.\d+$/, "Invalid browser version pin");
  const ordered = [...releases].sort((a, b) =>
    compareVersions(a.version, b.version),
  );
  assert.ok(ordered.length, "No Linux stable releases in Chrome Releases feed");
  const seen = new Set<string>();
  const advisories = [];
  for (const release of ordered) {
    for (const advisory of release.advisories) {
      const { id, issue } = advisory;
      const repeated = seen.has(id) || (issue !== undefined && seen.has(issue));
      seen.add(id);
      if (issue) seen.add(issue);
      if (repeated) continue;
      if (compareVersions(release.version, pinned) > 0) {
        advisories.push({
          ...advisory,
          fixedIn: release.version,
          url: release.url,
        });
      }
    }
  }
  return {
    pinned,
    stable: ordered.at(-1)?.version,
    advisories,
    blocking: advisories.filter(({ severity }) => severity !== "low"),
  };
}

export async function auditBrowser(pinned: string) {
  assert.match(pinned, /^\d+\.\d+\.\d+\.\d+$/, "Invalid browser version pin");
  const releases: Release[] = [];
  let start = 1;
  while (true) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      alt: "json",
      "max-results": "25",
      "start-index": String(start),
    }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok)
      throw new Error(`Chrome Releases feed HTTP ${response.status}`);
    const { feed } = (await response.json()) as Feed;
    for (const entry of feed.entry) {
      const url = entry.link.find(({ rel }) => rel === "alternate")?.href;
      if (!url) continue;
      const release = chromeRelease(entry.content.$t, url);
      if (release) releases.push(release);
    }
    if (
      releases.some(({ version }) => compareVersions(version, pinned) <= 0) ||
      !feed.link.some(({ rel }) => rel === "next")
    )
      break;
    if (!feed.entry.length)
      throw new Error("Empty page in Chrome Releases feed");
    start += feed.entry.length;
  }
  return browserReport(pinned, releases);
}
