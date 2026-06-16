import { MoniScoreData } from "./types";

const MONI_RENDER_WAIT_MS = Math.max(0, Number(process.env.MONI_RENDER_WAIT_MS || 12000));
const MONI_RENDER_TIMEOUT_MS = Math.max(1000, Number(process.env.MONI_RENDER_TIMEOUT_MS || 120000));
const MONI_SCORE_SELECTOR = '[class*="scoreModule_scoreBlockMoni"]';
const MONI_LOOKUP_TIMEOUT_FLOOR_MS = Math.min(MONI_RENDER_TIMEOUT_MS, MONI_RENDER_WAIT_MS + 5000);

export function buildMoniUrl(twitterHandle: string): string {
  return `https://discover.getmoni.io/${encodeURIComponent(twitterHandle)}`;
}

export function getMoniLookupTimeoutMs(configuredTimeoutMs?: number | string | null): number {
  const configured = Number(configuredTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(MONI_LOOKUP_TIMEOUT_FLOOR_MS, Math.trunc(configured));
  }
  return MONI_LOOKUP_TIMEOUT_FLOOR_MS;
}

type MoniCandidateOptions = {
  tokenSymbol?: string | null;
  includeTokenFallbacks?: boolean;
};

type MoniFetchOptions = MoniCandidateOptions & {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function alphanumeric(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "");
}

function addCandidate(candidates: string[], value: string | null | undefined): void {
  const candidate = String(value || "").trim().replace(/^@/, "");
  if (!candidate) return;
  candidates.push(candidate);
}

function normalizeFetchOptions(optionsOrSignal?: MoniFetchOptions | AbortSignal): MoniFetchOptions {
  if (!optionsOrSignal) return {};
  if ("aborted" in optionsOrSignal) return { signal: optionsOrSignal };
  return optionsOrSignal;
}

export function buildMoniHandleCandidates(
  twitterHandle: string,
  tokenName: string,
  options: MoniCandidateOptions = {},
): string[] {
  const handle = twitterHandle.trim();
  if (!handle) return [];

  const candidates: string[] = [];
  addCandidate(candidates, handle);

  const compactName = alphanumeric(tokenName);
  const compactHandle = alphanumeric(handle);
  const lowerName = compactName.toLowerCase();
  const lowerHandle = compactHandle.toLowerCase();

  if (compactName && lowerHandle.startsWith(lowerName) && handle === handle.toLowerCase()) {
    const suffix = compactHandle.slice(compactName.length);
    if (suffix) candidates.push(`${compactName}${suffix.toUpperCase()}`);
  }

  if (options.includeTokenFallbacks) {
    const compactSymbol = alphanumeric(String(options.tokenSymbol || ""));
    addCandidate(candidates, compactSymbol);
    addCandidate(candidates, compactSymbol.toLowerCase());
    addCandidate(candidates, compactName);
    addCandidate(candidates, compactName.toLowerCase());
  }

  return Array.from(new Set(candidates));
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
      onlyMainContent: false,
      maxAge: 0,
      storeInCache: false,
      proxy: "auto",
      removeBase64Images: true,
      blockAds: true,
      waitFor: MONI_RENDER_WAIT_MS,
      timeout: MONI_RENDER_TIMEOUT_MS,
      actions: [
        {
          type: "wait",
          selector: MONI_SCORE_SELECTOR,
        },
        {
          type: "wait",
          milliseconds: 1500,
        },
      ],
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

export async function fetchMoniScoreDataForToken(
  firecrawlApiKey: string,
  twitterHandle: string,
  tokenName: string,
  optionsOrSignal?: MoniFetchOptions | AbortSignal,
): Promise<MoniScoreData | null> {
  const options = normalizeFetchOptions(optionsOrSignal);
  for (const handle of buildMoniHandleCandidates(twitterHandle, tokenName, options)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = options.timeoutMs ? new AbortController() : null;
      let didTimeout = false;
      const timeout = controller
        ? setTimeout(() => {
            didTimeout = true;
            controller.abort();
          }, options.timeoutMs)
        : null;
      const relayAbort = () => controller?.abort();
      options.signal?.addEventListener("abort", relayAbort, { once: true });
      try {
        const score = await fetchMoniScoreData(firecrawlApiKey, handle, controller?.signal || options.signal);
        if (score) return score;
      } catch (error) {
        if (didTimeout) {
          throw new Error(`Moni scrape timed out for @${handle}`);
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", relayAbort);
      }
    }
  }

  return null;
}
