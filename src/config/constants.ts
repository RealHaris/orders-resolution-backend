/**
 * App-wide constants.
 */
export abstract class Constants {
  static readonly DEFAULT_PORT = 6011;

  /**
   * Maximum sockets a single process keeps open to MongoDB.
   */
  static readonly MONGO_MAX_POOL_SIZE = 50;

  /**
   * Minimum sockets kept warm per process.
   */
  static readonly MONGO_MIN_POOL_SIZE = 5;

  /**
   * Idle time (ms) after which a pooled connection is closed.
   */
  static readonly MONGO_MAX_IDLE_TIME_MS = 60_000;
}
