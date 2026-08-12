/**
 * Masks a sensitive string by keeping only the first two and last two characters.
 */
export function maskSensitiveValue(value?: string | null): string {
  if (!value) return "";
  if (value.length <= 4) {
    return `${value.slice(0, 2)}xxx${value.slice(-2)}`;
  }
  return `${value.slice(0, 2)}xxx${value.slice(-2)}`;
}

/**
 * Masks only credential parts in URI-like connection strings.
 */
export function maskConnectionStringCredentials(
  connectionString?: string
): string {
  if (!connectionString) return "";

  try {
    const parsedUrl = new URL(connectionString);
    const hasUsername = parsedUrl.username.length > 0;
    const hasPassword = parsedUrl.password.length > 0;

    if (!hasUsername && !hasPassword) {
      return connectionString;
    }

    if (hasUsername) {
      parsedUrl.username = maskSensitiveValue(parsedUrl.username);
    }

    if (hasPassword) {
      parsedUrl.password = maskSensitiveValue(parsedUrl.password);
    }

    return parsedUrl.toString();
  } catch {
    return "[INVALID_CONNECTION_STRING]";
  }
}
