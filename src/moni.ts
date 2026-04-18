export type MoniScoreData = {
  moniScore: number;
  moniLevel: number;
  moniLevelName: string;
  moniMomentumScorePct: number | null;
  moniMomentumRank: number | null;
};

export function buildMoniUrl(twitterHandle: string): string {
  return `https://discover.getmoni.io/${encodeURIComponent(twitterHandle)}`;
}

export function parseMoniMarkdown(markdown: string): MoniScoreData | null {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const scoreHeadingIndex = lines.findIndex((line) => line.toLowerCase() === "moni score");
  if (scoreHeadingIndex === -1) return null;

  const scoreWindow = lines.slice(scoreHeadingIndex, scoreHeadingIndex + 40);
  const levelIndex = scoreWindow.findIndex((line) => /^Level:\s*\d+\./i.test(line));
  if (levelIndex === -1) return null;

  const levelMatch = scoreWindow[levelIndex].match(/^Level:\s*(\d+)\.\s*(.+)$/i);
  if (!levelMatch) return null;

  const scoreLine = scoreWindow.slice(levelIndex + 1).find((line) => /^[\d,]+$/.test(line));
  if (!scoreLine) return null;

  const momentumHeadingIndex = lines.findIndex((line) => line.toLowerCase() === "momentum score");
  let moniMomentumRank: number | null = null;
  let moniMomentumScorePct: number | null = null;

  if (momentumHeadingIndex !== -1) {
    const momentumWindow = lines.slice(momentumHeadingIndex, momentumHeadingIndex + 20);
    const rankLine = momentumWindow.find((line) => /^Top\s+[\d,]+(?:\s+of\s+[\d,]+)?$/i.test(line));
    const pctLine = momentumWindow.find((line) => /^-?\d+(?:\.\d+)?%$/.test(line));
    const rankMatch = rankLine?.match(/^Top\s+([\d,]+)/i);
    if (rankMatch) moniMomentumRank = Number(rankMatch[1].replace(/,/g, ""));
    if (pctLine) moniMomentumScorePct = Number(pctLine.replace("%", ""));
  }

  return {
    moniScore: Number(scoreLine.replace(/,/g, "")),
    moniLevel: Number(levelMatch[1]),
    moniLevelName: levelMatch[2].trim(),
    moniMomentumScorePct,
    moniMomentumRank,
  };
}

export async function fetchMoniScoreData(
  firecrawlApiKey: string,
  twitterHandle: string,
  signal?: AbortSignal,
): Promise<MoniScoreData | null> {
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${firecrawlApiKey}`,
    },
    signal,
    body: JSON.stringify({
      url: buildMoniUrl(twitterHandle),
      formats: ["markdown"],
      onlyMainContent: true,
      maxAge: 0,
      storeInCache: false,
      proxy: "auto",
      removeBase64Images: true,
      blockAds: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firecrawl Moni scrape failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string };
    error?: string;
  };

  if (!payload.success) {
    throw new Error(payload.error || "Firecrawl returned an unsuccessful Moni response");
  }

  return parseMoniMarkdown(String(payload.data?.markdown || ""));
}
