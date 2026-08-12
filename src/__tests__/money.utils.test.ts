import { describe, expect, it } from "vitest";

import { ErrorData } from "@/types/error";
import { centsToDollars, dollarsToCents } from "@/utils/money.utils";

describe("dollarsToCents", () => {
  it("converts whole dollars, cents, and string amounts without float drift", () => {
    expect(dollarsToCents(19.99)).toBe(1999);
    expect(dollarsToCents("19.99")).toBe(1999);
    expect(dollarsToCents(12.5)).toBe(1250);
    expect(dollarsToCents("12.50")).toBe(1250);
    expect(dollarsToCents(0.01)).toBe(1);
    expect(dollarsToCents("0.01")).toBe(1);
    expect(dollarsToCents(1000)).toBe(100_000);
  });

  it("round-trips cents back to the same dollar number used on the API", () => {
    for (const dollars of [0.01, 0.1, 12.5, 19.99, 999.99, 1000]) {
      expect(centsToDollars(dollarsToCents(dollars))).toBe(dollars);
    }
  });

  it("rejects more than two decimal places", () => {
    expect(() => dollarsToCents(10.001)).toThrow(ErrorData);
    expect(() => dollarsToCents("10.001")).toThrow(ErrorData);
  });
});
