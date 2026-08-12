/**
 * Escapes user input before using it in a MongoDB $regex.
 */
export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
