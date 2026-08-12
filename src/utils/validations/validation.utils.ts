import type { Request } from "express";
import { validationResult } from "express-validator";

import { ErrorData, StatusCodes } from "@/types/error";

/**
 * Throws ErrorData 400 when express-validator found errors.
 */
export const validateExpressRequest = (req: Request) => {
  const errors = validationResult(req);
  const errorString = errors
    .array()
    .map((e) => e.msg)
    .join("\n");
  if (!errors.isEmpty()) {
    throw new ErrorData(
      errorString,
      "user",
      new Error(errorString),
      StatusCodes.BAD_REQUEST,
      false
    );
  }
};
