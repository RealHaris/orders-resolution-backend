import { RateLimiterMemory } from "rate-limiter-flexible";

import { RATE_LIMIT_CONFIG } from "@/config/rate-limit.config";

/**
 * Provider for in-memory rate limiter instances.
 */
class RateLimiterProvider {
  private limiters: Map<string, RateLimiterMemory> = new Map();

  constructor() {
    this.initializeLimiters();
  }

  /**
   * Initialize limiters based on configuration rules.
   */
  private initializeLimiters() {
    for (const [key, config] of Object.entries(RATE_LIMIT_CONFIG)) {
      const limiter = new RateLimiterMemory({
        keyPrefix: `rl_${key.toLowerCase()}`,
        points: config.points,
        duration: config.duration,
      });
      this.limiters.set(key, limiter);
    }
  }

  /**
   * Get a limiter instance by its rule name.
   * @param ruleName Name defined in RATE_LIMIT_CONFIG
   */
  getLimiter(ruleName: keyof typeof RATE_LIMIT_CONFIG): RateLimiterMemory {
    const limiter = this.limiters.get(ruleName);
    if (!limiter) {
      throw new Error(`Rate limiter rule "${ruleName}" not found.`);
    }
    return limiter;
  }
}

export const rateLimiterProvider = new RateLimiterProvider();
