export type MarketCapStatus =
  | "cross-checked"
  | "single-source"
  | "conflict"
  | "missing"
  | "legacy";
export type MarketCapEvidence = {
  status: MarketCapStatus;
  source: "coingecko" | "coinmarketcap" | "geckoterminal" | "none";
  observedAt: string | null;
  coingecko: number | null;
  coinmarketcap: number | null;
  differencePct: number | null;
  note?: string;
};

export function legacyMarketCapEvidence(
  value: number | null,
): MarketCapEvidence {
  return {
    status: value != null && value > 0 ? "legacy" : "missing",
    source: "none",
    observedAt: null,
    coingecko: null,
    coinmarketcap: null,
    differencePct: null,
  };
}
