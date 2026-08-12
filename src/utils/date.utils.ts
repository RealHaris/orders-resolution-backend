import { ErrorData, StatusCodes } from "@/types/error";

/** Builds a 400 ErrorData for malformed client date input. */
const invalidDate = () =>
  new ErrorData(
    "Date must be a valid ISO 8601 datetime or YYYY-MM-DD",
    "user",
    new Error("Invalid date"),
    StatusCodes.BAD_REQUEST,
    false
  );

/**
 * Parses a client date string to a UTC Date.
 * Accepts full ISO 8601 or calendar day (YYYY-MM-DD as UTC midnight).
 */
export const parseIsoDate = (value: string): Date => {
  const trimmed = value.trim();
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/;
  if (isoDay.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      throw invalidDate();
    }
    return date;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw invalidDate();
  }
  return date;
};

/**
 * Serializes a Date to ISO 8601 UTC. Use for every date field in API JSON.
 */
export const toIsoString = (date: Date): string => date.toISOString();

/**
 * UTC midnight of the calendar day of `date`.
 */
export const startOfUtcDay = (date: Date): Date => {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
};

/**
 * UTC midnight of today. Pass `now` in tests; default `new Date()`.
 */
export const startOfTodayUtc = (now: Date = new Date()): Date =>
  startOfUtcDay(now);
