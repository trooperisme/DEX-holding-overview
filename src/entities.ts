import fs from "node:fs";
import { ImportedEntity, EntityLinkType } from "./types";

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }

  return rows;
}

function parseZapperLink(fullZapperLink: string): {
  resolvedLabel: string | null;
  linkType: EntityLinkType;
  walletAddresses: string[];
} {
  const parsed = new URL(fullZapperLink);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const linkType = segments.includes("account") ? "account" : "bundle";
  const lastSegment = segments[segments.length - 1] || "";
  const walletAddresses = lastSegment
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const label = parsed.searchParams.get("label");

  return {
    resolvedLabel: label ? decodeURIComponent(label).trim() : null,
    linkType,
    walletAddresses,
  };
}

export function loadImportedEntities(csvPath: string): ImportedEntity[] {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Entities CSV not found at ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(content);
  const [header, ...dataRows] = rows;

  if (!header || header.length < 2) {
    throw new Error("Entities CSV is missing the expected header");
  }

  return dataRows
    .map((columns) => {
      const entityName = String(columns[0] || "").trim();
      const fullZapperLink = String(columns[1] || "").trim();
      if (!entityName || !fullZapperLink) return null;
      const parsed = parseZapperLink(fullZapperLink);
      return {
        entityName,
        fullZapperLink,
        resolvedLabel: parsed.resolvedLabel,
        linkType: parsed.linkType,
        walletAddresses: parsed.walletAddresses,
      };
    })
    .filter((value): value is ImportedEntity => Boolean(value));
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  return trimmed.length <= 6 ? trimmed : `...${trimmed.slice(-6)}`;
}

export function toTokenKey(input: {
  chainId: number | null;
  networkName: string;
  tokenAddress: string | null;
  tokenSymbol: string;
}): string {
  if (input.tokenAddress) {
    return `${input.chainId ?? "na"}:${input.tokenAddress.toLowerCase()}`;
  }
  return `${input.networkName.toLowerCase()}:${input.tokenSymbol.toUpperCase()}`;
}
