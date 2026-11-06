import { TrenchIndexSnapshot } from "./types";

export const TRENCH_INDEX_SOURCE_URL = "https://tehcscreener.com/api/trench";
const VALID_BANDS = new Set<TrenchIndexSnapshot["band"]>(["ded", "cold", "active", "hot", "euphoric"]);

type TehcTrenchPayload = {
  today?: {
    day?: unknown;
    score?: unknown;
    band?: unknown;
    components?: Record<string, { value?: unknown }>;
  };
};

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseTrenchIndexPayload(payload: unknown, fetchedAt = new Date().toISOString()): Omit<TrenchIndexSnapshot, "id"> {
  const today = (payload as TehcTrenchPayload | null)?.today;
  const score = finiteOrNull(today?.score);
  const band = String(today?.band || "").toLowerCase() as TrenchIndexSnapshot["band"];
  const day = String(today?.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || score == null || score < 0 || score > 100 || !VALID_BANDS.has(band)) {
    throw new Error("TehcScreener returned an invalid Trench Index payload");
  }

  const component = (name: string) => finiteOrNull(today?.components?.[name]?.value);
  return {
    day,
    score,
    band,
    padVolume: component("pad_volume"),
    tokensLaunched: component("tokens_launched"),
    botVolume: component("bot_volume"),
    botFees: component("bot_fees"),
    sourceUrl: TRENCH_INDEX_SOURCE_URL,
    fetchedAt,
  };
}

export async function fetchTrenchIndex(): Promise<Omit<TrenchIndexSnapshot, "id">> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(TRENCH_INDEX_SOURCE_URL, {
      headers: { accept: "application/json", "user-agent": "DEX Holding Overview/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TehcScreener Trench Index request failed (${response.status})`);
    return parseTrenchIndexPayload(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
