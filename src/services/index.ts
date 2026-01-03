/**
 * Request-Scoped Services
 *
 * Provides access to Cloudflare bindings and database connections
 * via HttpApiMiddleware for per-request isolation.
 *
 * ## Usage Pattern
 *
 * At request boundary (index.ts):
 * ```typescript
 * effect.pipe(withCloudflareBindings(env, ctx))
 * ```
 *
 * In handlers:
 * ```typescript
 * const { env, ctx } = yield* CloudflareBindings
 * const { drizzle } = yield* DatabaseService
 * ```
 *
 * @module
 */

// Cloudflare bindings middleware
export {
  CloudflareBindings,
  CloudflareBindingsError,
  CloudflareBindingsMiddleware,
  CloudflareBindingsMiddlewareLive,
  withCloudflareBindings,
  waitUntil,
  // FiberRef exports (for testing)
  currentEnv,
  currentCtx,
} from "./cloudflare.middleware"

// Database middleware
export {
  DatabaseService,
  DatabaseConnectionError,
  DatabaseMiddleware,
  DatabaseMiddlewareLive,
  PgDrizzle,
  type DrizzleInstance,
} from "./database.middleware"

// Legacy exports for backwards compatibility (deprecated)
export {
  getEnv,
  getCtx,
  withEnv,
  withCtx,
} from "./cloudflare"

export {
  getDrizzle,
  withDatabase,
} from "./database"
