export const HOLDINGS_PROVIDER = "cielo-firecrawl" as const;
export type HoldingsProvider = typeof HOLDINGS_PROVIDER;

export function getProviderLabel(): string {
  return "Cielo";
}

export function getCieloProviderConfig() {
  const numberFromEnv = (name: string, fallback: number): number => {
    const value = Number(process.env[name] || fallback);
    return Number.isFinite(value) ? value : fallback;
  };

  const minConcurrency = Math.max(1, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_MIN_CONCURRENCY", 1)));
  const maxConcurrency = Math.max(minConcurrency, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_MAX_CONCURRENCY", 3)));
  const concurrency = Math.max(
    minConcurrency,
    Math.min(maxConcurrency, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_CONCURRENCY", 2))),
  );

  return {
    concurrency,
    minConcurrency,
    maxConcurrency,
    successStreakToIncrease: Math.max(1, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_SUCCESS_STREAK_TO_INCREASE", 5))),
    entityRetryBaseDelayMs: Math.max(0, Math.trunc(numberFromEnv(
      "CIELO_FIRECRAWL_ENTITY_RETRY_BASE_MS",
      numberFromEnv("CIELO_FIRECRAWL_RATE_LIMIT_COOLDOWN_MS", 30000),
    ))),
    entityRetryMaxDelayMs: Math.max(1000, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_ENTITY_RETRY_MAX_MS", 300000))),
    waitMs: Math.max(0, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_WAIT_MS", 12000))),
    timeoutMs: Math.max(1000, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_TIMEOUT_MS", 75000))),
    retries: Math.max(0, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_RETRIES", 4))),
    retryBaseMs: Math.max(0, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_RETRY_BASE_MS", 1000))),
    rateLimitRetryMs: Math.max(0, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_RATE_LIMIT_RETRY_MS", 15000))),
    retryMaxMs: Math.max(0, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_RETRY_MAX_MS", 60000))),
    cacheMaxAgeMs: Math.max(0, Math.trunc(numberFromEnv("CIELO_FIRECRAWL_CACHE_MAX_AGE_MS", 300000))),
    storeInCache: String(process.env.CIELO_FIRECRAWL_STORE_IN_CACHE || "1") !== "0",
  };
}
