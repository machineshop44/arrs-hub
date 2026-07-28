const COMMITS_URL =
  "https://api.github.com/repos/TRaSH-Guides/Guides/commits?per_page=1";
const UPDATES_URL =
  "https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/docs/updates.txt";
const GUIDES_URL = "https://trash-guides.info/";
const CHANGELOG_URL =
  "https://github.com/TRaSH-Guides/Guides/blob/master/docs/updates.txt";

export interface TrashCommitInfo {
  sha: string;
  date: string;
  message: string;
  htmlUrl: string;
}

export interface TrashUpdateEntry {
  date: string;
  items: { title: string; url: string }[];
}

export interface TrashUpdatesSnapshot {
  commit: TrashCommitInfo;
  recent: TrashUpdateEntry[];
  guidesUrl: string;
  changelogUrl: string;
}

function parseUpdatesText(text: string, maxSections = 3): TrashUpdateEntry[] {
  const sections: TrashUpdateEntry[] = [];
  let current: TrashUpdateEntry | null = null;

  for (const line of text.split(/\r?\n/)) {
    const header = /^#\s+(.+)$/.exec(line);
    if (header) {
      if (sections.length >= maxSections) break;
      current = { date: header[1].trim(), items: [] };
      sections.push(current);
      continue;
    }

    if (!current) continue;
    const item = /^-\s+\[([^\]]+)\]\(([^)]+)\)/.exec(line);
    if (item) {
      current.items.push({ title: item[1], url: item[2] });
    }
  }

  return sections.filter((s) => s.items.length > 0);
}

export async function fetchTrashUpdates(): Promise<TrashUpdatesSnapshot> {
  const [commitsRes, updatesRes] = await Promise.all([
    fetch(COMMITS_URL, {
      headers: { Accept: "application/vnd.github+json" },
    }),
    fetch(UPDATES_URL, { cache: "no-store" }),
  ]);

  if (!commitsRes.ok) {
    throw new Error(`GitHub commits request failed (${commitsRes.status})`);
  }
  if (!updatesRes.ok) {
    throw new Error(`TRaSH updates.txt request failed (${updatesRes.status})`);
  }

  const commits = (await commitsRes.json()) as Array<{
    sha: string;
    html_url: string;
    commit: { message: string; author?: { date?: string } };
  }>;

  const latest = commits[0];
  if (!latest) throw new Error("No TRaSH Guides commits found");

  const updatesText = await updatesRes.text();

  return {
    commit: {
      sha: latest.sha,
      date: latest.commit.author?.date ?? "",
      message: latest.commit.message.split("\n")[0] ?? "",
      htmlUrl: latest.html_url,
    },
    recent: parseUpdatesText(updatesText, 3),
    guidesUrl: GUIDES_URL,
    changelogUrl: CHANGELOG_URL,
  };
}
