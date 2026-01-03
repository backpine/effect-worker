/**
 * Database Middleware
 *
 * Provides request-scoped database connections via HttpApiMiddleware.
 *
 * ## Why Per-Request Connections?
 *
 * Cloudflare Workers have strict I/O isolation - TCP connections opened in one
 * request cannot be used in another. This middleware creates a fresh connection
 * for each request and cleans it up when the request ends.
 *
 * ## Connection Lifecycle
 *
 * ```
 * Request starts
 *     │
 *     ▼
 * DatabaseMiddleware runs
 *     ├─→ Opens TCP connection to Postgres
 *     ├─→ Creates Drizzle instance
 *     ├─→ Provides DatabaseService to handlers
 *     │
 *     ▼
 * Handler executes
 *     └─→ yield* DatabaseService
 *         └─→ Queries database
 *     │
 *     ▼
 * Request ends (scope closes)
 *     └─→ Connection automatically closed
 * ```
 *
 * @module
 */
import { HttpApiMiddleware, HttpApiSchema } from "@effect/platform";
import {
  Context,
  Effect,
  FiberRef,
  Layer,
  Redacted,
  Schema as S,
} from "effect";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as SqlClient from "@effect/sql/SqlClient";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { currentEnv } from "./cloudflare.middleware";

// ============================================================================
// Types
// ============================================================================

/**
 * Type alias for the Drizzle database instance.
 */
export type DrizzleInstance = PgRemoteDatabase<Record<string, never>>;

// ============================================================================
// Service Definition
// ============================================================================

/**
 * DatabaseService provides access to a request-scoped Drizzle instance.
 *
 * @example
 * ```typescript
 * const { drizzle } = yield* DatabaseService
 * const users = yield* drizzle.select().from(usersTable)
 * ```
 */
export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  { readonly drizzle: DrizzleInstance }
>() {}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error when database connection fails.
 *
 * Returns 503 Service Unavailable to indicate the database is temporarily inaccessible.
 */
export class DatabaseConnectionError extends S.TaggedError<DatabaseConnectionError>()(
  "DatabaseConnectionError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

// ============================================================================
// Middleware Definition
// ============================================================================

/**
 * Middleware that provides DatabaseService to handlers.
 *
 * Apply this to groups that need database access:
 *
 * ```typescript
 * export const UsersGroup = HttpApiGroup.make("users")
 *   .add(...)
 *   .middleware(DatabaseMiddleware)
 *   .prefix("/users")
 * ```
 */
export class DatabaseMiddleware extends HttpApiMiddleware.Tag<DatabaseMiddleware>()(
  "DatabaseMiddleware",
  {
    failure: DatabaseConnectionError,
    provides: DatabaseService,
  },
) {}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default database URL for local development.
 */
const LOCAL_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/effect_worker";

// ============================================================================
// Middleware Implementation
// ============================================================================

/**
 * Live implementation of DatabaseMiddleware.
 *
 * Creates a scoped database connection per-request. The connection is
 * automatically closed when the request scope ends.
 *
 * Reads DATABASE_URL from FiberRef (set by withCloudflareBindings in entry point).
 */
export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    // Return the middleware effect (runs per-request)
    return Effect.gen(function* () {
      // Get connection string from Cloudflare env via FiberRef
      // (FiberRef reads don't create service dependencies)
      const env = yield* FiberRef.get(currentEnv);
      if (env === null) {
        return yield* Effect.fail(
          new DatabaseConnectionError({
            message:
              "Cloudflare env not available. Ensure withCloudflareBindings() wraps the handler.",
          }),
        );
      }
      const connectionString = env.DATABASE_URL ?? LOCAL_DATABASE_URL;

      // Create scoped PgClient (auto-closes when request ends)
      const pgClient = yield* PgClient.make({
        url: Redacted.make(connectionString),
      }).pipe(Effect.provide(Reactivity.layer));

      // Create Drizzle instance
      const drizzle = yield* PgDrizzle.make({
        casing: "snake_case",
      }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient));

      return { drizzle };
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new DatabaseConnectionError({
            message: `Database connection failed: ${String(error)}`,
          }),
        ),
      ),
    );
  }),
);

// Re-export for convenience
export { PgDrizzle };
