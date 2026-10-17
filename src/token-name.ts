const SOLANA_MINT_SUFFIX = /[1-9A-HJ-NP-Za-km-z]{32,44}pump$/;
const SOLANA_BASE58_SUFFIX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SHORT_EVM_ADDRESS_SUFFIX = /\s+0x[a-fA-F0-9]{2,8}\.\.\.[a-fA-F0-9]{3,8}$/;
const SHORT_BASE58_ADDRESS_SUFFIX = /\s+[1-9A-HJ-NP-Za-km-z]{3,10}\.\.\.(?:[1-9A-HJ-NP-Za-km-z]{3,10}|pump|meta)$/i;

function compact(value: string): string {
  return value.replace(/[^a-zA-Z0-9$-]/g, "").toUpperCase();
}

function firstToken(value: string): string {
  return value.trim().split(/\s+/)[0]?.replace(/[^\w$-]/g, "") || "";
}

function stripShortAddressSuffix(value: string): string {
  let stripped = value.trim();
  for (;;) {
    const next = stripped
      .replace(SHORT_EVM_ADDRESS_SUFFIX, "")
      .replace(SHORT_BASE58_ADDRESS_SUFFIX, "")
      .trim();
    if (next === stripped) return stripped;
    stripped = next;
  }
}

export function normalizeTokenSymbol(input: {
  tokenSymbol: string;
  tokenName: string;
}): string {
  const rawSymbol = String(input.tokenSymbol || "").trim();
  const rawName = String(input.tokenName || "").trim();
  const fallback = rawSymbol || "UNKNOWN";
  const leadingNameToken = firstToken(rawName);
  if (!leadingNameToken) return fallback;

  const compactSymbol = compact(rawSymbol);
  const compactLeadingNameToken = compact(leadingNameToken);
  const compactRawName = compact(rawName);
  if (!compactSymbol) return leadingNameToken;
  if (compactSymbol === compactLeadingNameToken) return rawSymbol || leadingNameToken;

  const looksConcatenated =
    compactSymbol === compactRawName ||
    compactSymbol.length > Math.max(12, compactLeadingNameToken.length + 6) ||
    /0X[A-F0-9]{4,}$/i.test(compactSymbol) ||
    /(?:PUMP|META)$/i.test(compactSymbol);

  if (looksConcatenated && compactSymbol.startsWith(compactLeadingNameToken)) {
    return leadingNameToken;
  }

  return fallback;
}

export function normalizeTokenName(input: {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  tokenKey?: string | null;
  networkName?: string | null;
}): string {
  const rawName = String(input.tokenName || "").trim();
  const normalizedSymbol = normalizeTokenSymbol({
    tokenSymbol: input.tokenSymbol,
    tokenName: input.tokenName,
  });
  const fallback = normalizedSymbol || String(input.tokenSymbol || "Unknown token").trim() || "Unknown token";
  const tokenKeyAddress = String(input.tokenKey || "").split(":").pop() || "";
  const tokenAddressCandidates = [
    String(input.tokenAddress || "").trim(),
    tokenKeyAddress.trim(),
  ].filter(Boolean);

  if (!rawName) return fallback;

  let cleanedName = rawName;
  for (const tokenAddress of tokenAddressCandidates) {
    if (cleanedName.toLowerCase().endsWith(tokenAddress.toLowerCase())) {
      cleanedName = cleanedName.slice(0, -tokenAddress.length).trim();
      break;
    }
  }
  cleanedName = stripShortAddressSuffix(cleanedName);

  if (normalizedSymbol && cleanedName.toLowerCase().startsWith(`${normalizedSymbol.toLowerCase()} `)) {
    const withoutSymbol = cleanedName.slice(normalizedSymbol.length).trim();
    if (withoutSymbol) cleanedName = withoutSymbol;
  }

  const isSolana = String(input.networkName || "").toLowerCase() === "solana";
  if (!isSolana) return cleanedName || fallback;

  const pumpMintSuffix = cleanedName.match(SOLANA_MINT_SUFFIX);
  if (pumpMintSuffix && pumpMintSuffix.index && pumpMintSuffix.index > 0) {
    const stripped = cleanedName.slice(0, pumpMintSuffix.index).trim();
    return stripped || fallback;
  }

  const tokenSymbol = normalizedSymbol;
  if (tokenSymbol && cleanedName.includes(tokenSymbol)) {
    const suffixAfterSymbol = cleanedName.slice(cleanedName.lastIndexOf(tokenSymbol) + tokenSymbol.length);
    if (SOLANA_BASE58_SUFFIX.test(suffixAfterSymbol)) {
      return cleanedName.slice(0, cleanedName.length - suffixAfterSymbol.length).trim() || fallback;
    }
  }

  return cleanedName || fallback;
}
