/**
 * Rate limiting configuration rules.
 */
export const RATE_LIMIT_CONFIG = {
  API_GENERAL: {
    points: 120,
    duration: 60,
  },
  AUTH_LOGIN_REGISTER: {
    points: 5,
    duration: 30,
  },
} as const;
