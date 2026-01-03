/**
 * Database Service
 *
 * Provides access to a Drizzle ORM instance for database operations.
 *
 * ## Usage
 *
 * In handlers (HTTP or Queue):
 * ```typescript
 * const { drizzle } = yield* DatabaseService
 * const users = yield* drizzle.select().from(usersTable)
 * ```
 *
 * @module
 */
import { Context, Effect, Redacted, Schema as S } from "effect";
import { HttpApiSchema } from "@effect/platform";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as SqlClient from "@effect/sql/SqlClient";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";

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
 * Returns 503 Service Unavailable.
 */
export class DatabaseConnectionError extends S.TaggedError<DatabaseConnectionError>()(
  "DatabaseConnectionError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default database URL for local development.
 */
export const LOCAL_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/effect_worker";

// ============================================================================
// Connection Factory
// ============================================================================

/**
 * Create a scoped database connection.
 *
 * Used by both HTTP middleware and Queue handlers.
 * The connection is automatically closed when the scope ends.
 *
 * @param connectionString - PostgreSQL connection URL
 */
export const makeDatabaseConnection = (connectionString: string) =>
  Effect.gen(function* () {
    const pgClient = yield* PgClient.make({
      url: Redacted.make(connectionString),
    }).pipe(Effect.provide(Reactivity.layer));

    const drizzle = yield* PgDrizzle.make({
      casing: "snake_case",
    }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient));

    return { drizzle };
  });

// Re-export for convenience
export { PgDrizzle };
