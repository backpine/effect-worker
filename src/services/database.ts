/**
 * Database Service (Request-Scoped)
 *
 * Provides access to Drizzle ORM using Effect's FiberRef pattern.
 *
 * ## Why Per-Request Database Connections?
 *
 * Cloudflare Workers run in a serverless environment where:
 *
 * 1. **No persistent connections**: Workers are stateless and may be
 *    terminated at any time. Connection pools don't work reliably.
 *
 * 2. **Isolate recycling**: The same isolate may handle multiple requests,
 *    but you cannot rely on state persisting between them.
 *
 * 3. **TCP connections**: Each request opens a fresh TCP connection to the
 *    database and closes it when done. This is required for proper isolation.
 *
 * ## Connection Pattern
 *
 * ```
 * Request 1:  [open connection] → [query] → [close connection]
 * Request 2:  [open connection] → [query] → [close connection]
 * ```
 *
 * This differs from traditional Node.js apps that maintain connection
 * pools across requests.
 *
 * ## Why FiberRef for Database?
 *
 * Same reasoning as CloudflareEnv - we need per-request instances without
 * layer dependencies. See cloudflare.ts for the detailed explanation.
 *
 * @module
 */
import * as Reactivity from "@effect/experimental/Reactivity"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import { PgClient } from "@effect/sql-pg"
import * as SqlClient from "@effect/sql/SqlClient"
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy"
import { Effect, FiberRef, Redacted } from "effect"

/**
 * Type alias for the underlying Drizzle database instance.
 */
type DrizzleInstance = PgRemoteDatabase<Record<string, never>>

/**
 * FiberRef holding the current request's Drizzle instance.
 */
export const currentDrizzle = FiberRef.unsafeMake<DrizzleInstance | null>(null)

/**
 * Get the current Drizzle instance.
 *
 * Dies if called outside of withDatabase() scope.
 *
 * @example
 * ```typescript
 * const drizzle = yield* getDrizzle
 * const users = yield* drizzle.select().from(usersTable).limit(10)
 * ```
 */
export const getDrizzle = Effect.gen(function* () {
  const drizzle = yield* FiberRef.get(currentDrizzle)
  if (drizzle === null) {
    return yield* Effect.die(
      "Database not available. Ensure withDatabase() wraps the handler.",
    )
  }
  return drizzle
})

/**
 * Create a scoped database connection and make it available via FiberRef.
 *
 * ## Scope and Cleanup
 *
 * This uses Effect.scoped to ensure the connection is properly closed:
 *
 * ```typescript
 * withDatabase(url)(myEffect)
 * // Expands to:
 * Effect.scoped(
 *   PgClient.make(...) // Create connection
 *   Effect.locally(currentDrizzle, drizzle)(myEffect)
 *   // Connection auto-closes when scope ends
 * )
 * ```
 *
 * ## Security Note
 *
 * The connection string should come from Cloudflare secrets (env.DATABASE_URL),
 * not hardcoded values.
 *
 * @param connectionString - PostgreSQL connection URL
 */
export const withDatabase = (connectionString: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Create PgClient (scoped - auto-closes when scope ends)
        const pgClient = yield* PgClient.make({
          url: Redacted.make(connectionString),
        }).pipe(Effect.provide(Reactivity.layer))

        // Create Drizzle instance
        const drizzle = yield* PgDrizzle.make({
          casing: "snake_case",
        }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

        // Run effect with Drizzle available via FiberRef
        return yield* Effect.locally(currentDrizzle, drizzle)(effect)
      }),
    )

// Re-export for type usage
export { PgDrizzle }
