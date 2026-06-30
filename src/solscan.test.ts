import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSolscanTokenName,
  parseSolscanPortfolioMarkdown,
  SOLANA_CHAIN_ID,
  toSolanaTokenBalance,
} from "./solscan";

const SAMPLE_MARKDOWN = `
Total 405 token accounts

| Token Account | Token Name | Symbol | Token Balance | Price | Value | Percentage |
| --- | --- | --- | --- | --- | --- | --- |
| [8eebNyWyrqBGbNwhwWM7yAoFxgUrgpg4UNGS4A33RQ6g](https://solscan.io/account/8eebNyWyrqBGbNwhwWM7yAoFxgUrgpg4UNGS4A33RQ6g) | ![image](https://statics.solscan.io/cdn/imgs/s60?ref=x)<br>[Collector Crypt](https://solscan.io/token/CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp) | CARDS | 1,551,270.2 | $0.2287<br>2.01% | $354,846.42 | 89.42% |
| [2nsku2j3G5Ge5aYy9jjhdrhrdF4hk6x5n4Y3wzZXkhao](https://solscan.io/account/2nsku2j3G5Ge5aYy9jjhdrhrdF4hk6x5n4Y3wzZXkhao) | ![placeholder](https://solscan.io/_next/static/media/FallbackCoin.f6322771.png)<br>[Pod the Squire](https://solscan.io/token/EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA) | SQUIRE | 6,900,000 | $0.003028<br>24.45% | $20,896.53 | 5.26% |
| [914nFyKRoypna4cu7nWkeKBxPuceGTcCCsoZB8k3mVsw](https://solscan.io/account/914nFyKRoypna4cu7nWkeKBxPuceGTcCCsoZB8k3mVsw) | ![placeholder](https://solscan.io/_next/static/media/FallbackCoin.f6322771.png)<br>[PUMPCADE](https://solscan.io/token/Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu) | PUMPCADE | 1,000,000 | $0.01543<br>4.14% | $15,436.43 | 3.89% |
| [F26YpRnYDxrPhVQtwWm41buq3p4RDcEJypDGYMJnhdh6](https://solscan.io/account/F26YpRnYDxrPhVQtwWm41buq3p4RDcEJypDGYMJnhdh6) | ![placeholder](https://solscan.io/_next/static/media/FallbackCoin.f6322771.png)<br>[The Collector Group](https://solscan.io/token/DLGRpmkMGr7J4KD1xR5x2XjaGeQH64PLFQkyxNNSpump) | TCG | 1,250,000 | $0.004458 | $5,572.94 | 1.4% |
| [E1WGkjURyyhGxRegDytJZY1Ct9dM58ZBMv3HG7xjEXBm](https://solscan.io/account/E1WGkjURyyhGxRegDytJZY1Ct9dM58ZBMv3HG7xjEXBm) | ![image](https://statics.solscan.io/cdn/imgs/s60?ref=x)<br>[USDC](https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) | USDC | 51.72 | $1<br>0.0429% | $51.75 | 0.01304% |
`;

test("parseSolscanPortfolioMarkdown extracts top holdings above the USD threshold", () => {
  const rows = parseSolscanPortfolioMarkdown(SAMPLE_MARKDOWN, 111);

  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => row.tokenSymbol),
    ["CARDS", "SQUIRE", "PUMPCADE", "TCG"],
  );
  assert.equal(rows[0].tokenName, "Collector Crypt");
  assert.equal(rows[0].tokenAddress, "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");
  assert.equal(rows[0].balanceUsd, 354846.42);
  assert.equal(rows[0].balance, "1551270.2");
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "balance",
    "balanceUsd",
    "tokenAddress",
    "tokenName",
    "tokenSymbol",
  ]);
});

test("parseSolscanPortfolioMarkdown strips Solana mint suffixes from token names", () => {
  const markdown = `
| Token Account | Token Name | Symbol | Token Balance | Price | Value | Percentage |
| --- | --- | --- | --- | --- | --- | --- |
| [8eeb](https://solscan.io/account/8eeb) | [Collector CryptCARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp](https://solscan.io/token/CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp) | CARDS | 1,551,270.2 | $0.2287 | $354,846.42 | 89.42% |
| [9abc](https://solscan.io/account/9abc) | [The Black Bull9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump](https://solscan.io/token/9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump) | ANSEM | 100 | $1 | $10,000 | 1% |
`;

  const rows = parseSolscanPortfolioMarkdown(markdown, 111);

  assert.deepEqual(
    rows.map((row) => row.tokenName),
    ["Collector Crypt", "The Black Bull"],
  );
});

test("normalizeSolscanTokenName keeps legitimate pump names", () => {
  assert.equal(
    normalizeSolscanTokenName({
      tokenName: "DONALD J. PUMP",
      tokenSymbol: "DJPUMP",
      tokenAddress: "36CdR7EzFZgu4aEswP6xJy11x3y4sKN62Fc84CGdpump",
    }),
    "DONALD J. PUMP",
  );
});

test("toSolanaTokenBalance converts Solscan holdings into the existing balance shape", () => {
  const [holding] = parseSolscanPortfolioMarkdown(SAMPLE_MARKDOWN, 111);
  const balance = toSolanaTokenBalance(holding);

  assert.equal(balance.networkName, "Solana");
  assert.equal(balance.chainId, SOLANA_CHAIN_ID);
  assert.equal(balance.tokenSymbol, "CARDS");
  assert.equal(balance.tokenAddress, "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");
  assert.equal(balance.balanceUsd, 354846.42);
  assert.equal(balance.price, null);
  assert.equal(balance.marketCap, null);
  assert.equal(balance.liquidityUsd, null);
});
