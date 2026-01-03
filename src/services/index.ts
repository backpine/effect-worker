/**
 * Request-Scoped Services
 *
 * Provides access to Cloudflare bindings and database connections
 * using Effect's FiberRef pattern for per-request isolation.
 *
 * ## Usage Pattern
 *
 * At request boundary (index.ts):
 * ```typescript
 * effect.pipe(
 *   withDatabase(env.DATABASE_URL),
 *   withEnv(env),
 *   withCtx(ctx),
 * )
 * ```
 *
 * In handlers:
 * ```typescript
 * const env = yield* getEnv
 * const drizzle = yield* getDrizzle
 * ```
 *
 * @module
 */
export {
  currentEnv,
  currentCtx,
  getEnv,
  getCtx,
  withEnv,
  withCtx,
  waitUntil,
} from "./cloudflare"

export {
  PgDrizzle,
  getDrizzle,
  withDatabase,
} from "./database"
