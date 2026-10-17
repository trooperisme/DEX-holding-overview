import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTokenName, normalizeTokenSymbol } from "./token-name";

test("normalizeTokenSymbol repairs Cielo concatenated symbol/name/address tickers", () => {
  assert.equal(normalizeTokenSymbol({
    tokenSymbol: "USDCUSDCOIN0XA0EB48",
    tokenName: "USDC USD Coin 0xa0...eb48",
  }), "USDC");

  assert.equal(normalizeTokenSymbol({
    tokenSymbol: "ETHETHEREUM",
    tokenName: "ETH Ethereum",
  }), "ETH");

  assert.equal(normalizeTokenSymbol({
    tokenSymbol: "FARTCOINFARTCOIN9BB6PUMP",
    tokenName: "Fartcoin Fartcoin 9BB6...pump",
  }), "Fartcoin");
});

test("normalizeTokenName strips duplicated symbol prefixes and short address suffixes", () => {
  assert.equal(normalizeTokenName({
    tokenSymbol: "USDCUSDCOIN0XA0EB48",
    tokenName: "USDC USD Coin 0xa0...eb48",
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    tokenKey: "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    networkName: "Ethereum",
  }), "USD Coin");

  assert.equal(normalizeTokenName({
    tokenSymbol: "ETHETHEREUM",
    tokenName: "ETH Ethereum",
    tokenAddress: null,
    tokenKey: "ethereum:ETHETHEREUM",
    networkName: "Ethereum",
  }), "Ethereum");

  assert.equal(normalizeTokenName({
    tokenSymbol: "FARTCOINFARTCOIN9BB6PUMP",
    tokenName: "Fartcoin Fartcoin 9BB6...pump",
    tokenAddress: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    tokenKey: "1151111081:9bb6nfecjbctnnlfko2fqvqbq8hhm13kcyycdqbgpump",
    networkName: "Solana",
  }), "Fartcoin");
});
