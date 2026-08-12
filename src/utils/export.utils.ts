import { Parser as CSVParser } from "@json2csv/plainjs";
import type { Response } from "express";

import {
  ORDER_EXPORT_FIELD_HEADERS,
  ORDER_EXPORT_FIELDS,
} from "@/constants/order.constants";

/**
 * Builds a CSV string from rows using ordered field ids and header labels.
 */
export const buildExportCsv = (
  rows: Record<string, unknown>[],
  fields: readonly string[] = ORDER_EXPORT_FIELDS,
  headerMap: Record<string, string> = ORDER_EXPORT_FIELD_HEADERS
): string => {
  const csvFields = fields.map((field) => ({
    label: headerMap[field] ?? field,
    value: field,
  }));
  const parser = new CSVParser({ fields: csvFields });
  const csv = parser.parse(rows.length === 0 ? [{}] : rows);
  if (rows.length === 0) {
    return csv.split(/\r?\n/)[0];
  }
  return csv;
};

/**
 * Sends a CSV attachment response (orders-resolution export pattern).
 */
export const sendExportFile = (
  res: Response,
  fileName: string,
  body: string
): Response => {
  const safeName = String(fileName || "export").replace(
    /[^a-zA-Z0-9._-]/g,
    "_"
  );
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${safeName}.csv`);
  return res.status(200).send(body);
};
