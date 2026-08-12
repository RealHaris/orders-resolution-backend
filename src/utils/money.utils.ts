import { ErrorData, StatusCodes } from "@/types/error";

/**
 * Converts a dollar amount to cents.
 * Requires a finite value with at most 2 decimal places (validated on the decimal string).
 */
export const dollarsToCents = (value: number | string): number => {
  const raw = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new ErrorData(
      "Amount must be a number with at most 2 decimal places",
      "user",
      new Error("Invalid money format"),
      StatusCodes.BAD_REQUEST,
      false
    );
  }
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  if (!Number.isInteger(cents)) {
    throw new ErrorData(
      "Amount must be a number with at most 2 decimal places",
      "user",
      new Error("Invalid money integer"),
      StatusCodes.BAD_REQUEST,
      false
    );
  }
  return negative ? -cents : cents;
};

/**
 * Cents to dollars number for JSON (e.g. 1000 → 10, 33 → 0.33).
 */
export const centsToDollars = (cents: number): number => cents / 100;
