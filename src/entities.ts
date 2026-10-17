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

export function parseCieloEntityCsv(content: string): {
  entities: ImportedEntity[];
  invalidRows: Array<{ rowNumber: number; entityName: string; link: string }>;
} {
  const rows = parseCsv(content);
  const [header, ...dataRows] = rows;
  const normalizedHeader = header?.map((value) => value.trim().toLowerCase());
  if (!normalizedHeader || normalizedHeader.length < 2) {
    throw new Error("Cielo entities CSV is missing the expected header: entity,cielo_link");
  }

  const entityIndex = normalizedHeader.indexOf("entity");
  const linkIndex = normalizedHeader.indexOf("cielo_link");
  if (entityIndex < 0 || linkIndex < 0) {
    throw new Error("Cielo entities CSV must contain entity,cielo_link headers");
  }

  const entities: ImportedEntity[] = [];
  const invalidRows: Array<{ rowNumber: number; entityName: string; link: string }> = [];
  const occurrencesByBundleId = new Map<string, number>();
  for (const [index, columns] of dataRows.entries()) {
    const entityName = String(columns[entityIndex] || "").trim();
    const link = String(columns[linkIndex] || "").trim();
    if (!entityName && !link) continue;

    try {
      const parsed = new URL(link);
      const match = parsed.pathname.match(/^\/bundles\/(\d+)\/portfolio\/?$/);
      if (parsed.hostname !== "app.cielo.finance" || !match) throw new Error("invalid Cielo portfolio URL");
      const bundleId = match[1];
      const occurrence = occurrencesByBundleId.get(bundleId) || 0;
      occurrencesByBundleId.set(bundleId, occurrence + 1);
      const sourceUrl = new URL(link);
      if (occurrence > 0) sourceUrl.hash = `entity-row=${index + 2}`;
      entities.push({
        entityName,
        sourceUrl: sourceUrl.toString(),
        resolvedLabel: entityName || null,
        linkType: "bundle",
        walletAddresses: [],
      });
    } catch {
      invalidRows.push({ rowNumber: index + 2, entityName, link });
    }
  }

  return { entities, invalidRows };
}

export function loadTrackedEntities(csvPath: string): ImportedEntity[] {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Cielo entities CSV not found at ${csvPath}`);
  }
  const parsed = parseCieloEntityCsv(fs.readFileSync(csvPath, "utf8"));
  if (parsed.invalidRows.length) {
    const details = parsed.invalidRows
      .slice(0, 3)
      .map((row) => `row ${row.rowNumber} (${row.entityName || "unnamed"})`)
      .join(", ");
    throw new Error(`Cielo entities CSV contains invalid portfolio URL(s): ${details}`);
  }
  if (!parsed.entities.length) {
    throw new Error("Cielo entities CSV contains no valid entities");
  }
  return parsed.entities;
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
