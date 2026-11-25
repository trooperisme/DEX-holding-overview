import { canonicalAddress, fetchSnapshotMarketCaps, marketCapTokenKey, selectMarketCap } from "./market-cap";
import { fetchGeckoTerminalMarketData, type GeckoTerminalMarketData, toGeckoTerminalNetworkId } from "./geckoterminal";
import { createStorage } from "./storage";
import { throwIfAborted } from "./refresh-support";
import type { RefreshLogTone } from "./types";

type MarketEvidenceCallbacks = { onLog?: (tone: RefreshLogTone, message: string) => void };

export async function enrichSnapshotMarketData(options: {
  storage: ReturnType<typeof createStorage>;
  snapshotId: number;
  totalEntities: number;
  signal?: AbortSignal;
  callbacks: MarketEvidenceCallbacks;
}): Promise<{ attempted: number; enriched: number; failed: number }> {
  const startedAt = Date.now();
  const snapshotTokens = (await options.storage.getSnapshotTokensForEnrichment(options.snapshotId, 111, 1))
    .filter((token) => token.tokenAddress)
    .slice(0, options.totalEntities <= 1 ? 25 : undefined);

  if (!snapshotTokens.length) {
    options.callbacks.onLog?.("info", "No enrichable token contracts found for GeckoTerminal market-data lookup.");
    return { attempted: 0, enriched: 0, failed: 0 };
  }

  options.callbacks.onLog?.(
    "info",
    `Enriching ${snapshotTokens.length} unique tokens with GeckoTerminal pool data and CoinGecko/CoinMarketCap MCAP checks.`,
  );

  let marketDataByTokenAddress: Map<string, GeckoTerminalMarketData>;
  const geckoStartedAt = Date.now();
  try {
    marketDataByTokenAddress = await fetchGeckoTerminalMarketData(
      snapshotTokens.map((token) => ({
        tokenAddress: token.tokenAddress!,
        chainId: token.chainId,
        networkName: token.networkName,
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.callbacks.onLog?.("warning", `GeckoTerminal enrichment skipped: ${message}`);
    marketDataByTokenAddress = new Map();
  }

  const geckoElapsedMs = Date.now() - geckoStartedAt;
  throwIfAborted(options.signal);
  const capStartedAt = Date.now();
  const capQuotes = await fetchSnapshotMarketCaps(snapshotTokens.map(token => ({ tokenAddress: token.tokenAddress!, chainId: token.chainId, networkName: token.networkName })));
  const capElapsedMs = Date.now() - capStartedAt;
  let enriched = 0;
  let failed = 0;
  let marketCapsFound = 0;
  let tokenAgesFound = 0;
  for (const token of snapshotTokens) {
    if (options.signal?.aborted) {
      throw new DOMException("Refresh canceled", "AbortError");
    }

    const geckoNetworkId = toGeckoTerminalNetworkId(token.chainId, token.networkName);
    const marketData = token.tokenAddress
      ? marketDataByTokenAddress.get(`${geckoNetworkId || "unknown"}:${canonicalAddress(token.tokenAddress)}`)
      : null;

    const external = capQuotes.get(marketCapTokenKey({ tokenAddress: token.tokenAddress!, chainId: token.chainId, networkName: token.networkName }));
    if (!marketData && !external?.marketCap && external?.marketCapEvidence.status !== "conflict") {
      failed += 1;
      options.callbacks.onLog?.("warning", `GeckoTerminal market-data lookup returned no token data for ${token.tokenSymbol}.`);
      continue;
    }

    const quote = external?.marketCapEvidence.status === "conflict" || external?.marketCap != null
      ? external
      : selectMarketCap(null, null, new Date().toISOString(), marketData?.marketCap || null);
    const enrichedData = { liquidityUsd: null, volume24h: null, txns24h: null, tokenAgeHours: null, ...marketData, ...quote };
    await options.storage.updateSnapshotTokenMarketData(options.snapshotId, token.tokenKey, enrichedData);
    enriched += 1;
    if (enrichedData.marketCap != null) marketCapsFound += 1;
    if (enrichedData.tokenAgeHours != null) tokenAgesFound += 1;
  }

  options.callbacks.onLog?.(
    failed > 0 || marketCapsFound < snapshotTokens.length || tokenAgesFound < snapshotTokens.length ? "warning" : "success",
    failed > 0
      ? `GeckoTerminal enrichment finished: ${enriched}/${snapshotTokens.length} tokens with pair data, ${failed} missing pair data; market cap ${marketCapsFound}/${snapshotTokens.length}, token age ${tokenAgesFound}/${snapshotTokens.length}.`
      : `GeckoTerminal enrichment finished: ${enriched}/${snapshotTokens.length} tokens with pair data; market cap ${marketCapsFound}/${snapshotTokens.length}, token age ${tokenAgesFound}/${snapshotTokens.length}.`,
  );

  options.callbacks.onLog?.("info", `Market evidence timing: Gecko ${geckoElapsedMs}ms, MCAP sources ${capElapsedMs}ms, total ${Date.now() - startedAt}ms.`);
  return {
    attempted: snapshotTokens.length,
    enriched,
    failed,
  };
}

