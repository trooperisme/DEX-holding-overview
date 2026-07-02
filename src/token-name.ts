const SOLANA_MINT_SUFFIX = /[1-9A-HJ-NP-Za-km-z]{32,44}pump$/;
const SOLANA_BASE58_SUFFIX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function normalizeTokenName(input: {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  tokenKey?: string | null;
  networkName?: string | null;
}): string {
  const rawName = String(input.tokenName || "").trim();
  const fallback = String(input.tokenSymbol || "Unknown token").trim() || "Unknown token";
  const tokenKeyAddress = String(input.tokenKey || "").split(":").pop() || "";
  const tokenAddressCandidates = [
    String(input.tokenAddress || "").trim(),
    tokenKeyAddress.trim(),
  ].filter(Boolean);

  if (!rawName) return fallback;

  for (const tokenAddress of tokenAddressCandidates) {
    if (rawName.toLowerCase().endsWith(tokenAddress.toLowerCase())) {
      const stripped = rawName.slice(0, -tokenAddress.length).trim();
      return stripped || fallback;
    }
  }

  const isSolana = String(input.networkName || "").toLowerCase() === "solana";
  if (!isSolana) return rawName;

  const pumpMintSuffix = rawName.match(SOLANA_MINT_SUFFIX);
  if (pumpMintSuffix && pumpMintSuffix.index && pumpMintSuffix.index > 0) {
    const stripped = rawName.slice(0, pumpMintSuffix.index).trim();
    return stripped || fallback;
  }

  const tokenSymbol = String(input.tokenSymbol || "").trim();
  if (tokenSymbol && rawName.includes(tokenSymbol)) {
    const suffixAfterSymbol = rawName.slice(rawName.lastIndexOf(tokenSymbol) + tokenSymbol.length);
    if (SOLANA_BASE58_SUFFIX.test(suffixAfterSymbol)) {
      return rawName.slice(0, rawName.length - suffixAfterSymbol.length).trim() || fallback;
    }
  }

  return rawName;
}
