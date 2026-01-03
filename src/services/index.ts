/**
 * Services
 *
 * Service definitions (Context.Tag) for dependency injection.
 * These are the "what" - the contracts that handlers depend on.
 *
 * For HTTP middleware implementations, see @/http/middleware.
 * For Queue layer implementations, see @/queue/handler.
 *
 * @module
 */

// Cloudflare bindings service
export {
  CloudflareBindings,
  CloudflareBindingsError,
  withCloudflareBindings,
  waitUntil,
  currentEnv,
  currentCtx,
} from "./cloudflare";

// Database service
export {
  DatabaseService,
  DatabaseConnectionError,
  makeDatabaseConnection,
  LOCAL_DATABASE_URL,
  PgDrizzle,
  type DrizzleInstance,
} from "./database";
