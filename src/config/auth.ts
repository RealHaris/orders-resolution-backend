/**
 * Cookie and JWT lifetime configuration.
 */
export abstract class AuthConfig {
  static readonly COOKIE_MAX_AGE_IN_DAYS = 7;
  static readonly ACCESS_TOKEN_EXPIRES = "7d";
}
