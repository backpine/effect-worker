/**
 * Database RPC Middleware
 *
 * RpcMiddleware that provides DatabaseService to RPC handlers.
 * Creates a fresh database connection per-request.
 *
 * @module
 */
import { RpcMiddleware } from "@effect/rpc"
import { Effect, FiberRef, Layer } from "effect"
import {
  DatabaseService,
  DatabaseConnectionError,
  makeDatabaseConnection,
  LOCAL_DATABASE_URL,
  type DrizzleInstance,
} from "@/services/database"
import { currentEnv } from "@/services/cloudflare"

// ============================================================================
// Middleware Definition
// ============================================================================

/**
 * Middleware that provides DatabaseService to RPC handlers.
 *
 * Apply to RPC procedures that need database access:
 *
 * ```typescript
 * const myRpc = Rpc.make("myRpc", { ... })
 *   .middleware(RpcDatabaseMiddleware)
 * ```
 */
export class RpcDatabaseMiddleware extends RpcMiddleware.Tag<RpcDatabaseMiddleware>()(
  "RpcDatabaseMiddleware",
  {
    failure: DatabaseConnectionError,
    provides: DatabaseService,
  },
) {}

// ============================================================================
// Middleware Implementation
// ============================================================================

/**
 * Live implementation of RpcDatabaseMiddleware.
 *
 * Creates a scoped database connection per-request.
 * The connection is automatically closed when the request scope ends.
 *
 * Note: The middleware returns a scoped Effect. The RpcServer provides
 * the Scope at runtime when executing handlers.
 */
export const RpcDatabaseMiddlewareLive = Layer.succeed(
  RpcDatabaseMiddleware,
  // Middleware function runs per-RPC-call
  // Note: Type cast needed because RpcMiddleware doesn't include Scope in type,
  // but RpcServer runs handlers in a scoped context
  (() =>
    Effect.gen(function* () {
      // Get connection string from Cloudflare env via FiberRef
      const env = yield* FiberRef.get(currentEnv)
      if (env === null) {
        return yield* Effect.fail(
          new DatabaseConnectionError({
            message:
              "Cloudflare env not available. Ensure withCloudflareBindings() wraps the handler.",
          }),
        )
      }

      const connectionString = env.DATABASE_URL ?? LOCAL_DATABASE_URL
      return yield* makeDatabaseConnection(connectionString)
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new DatabaseConnectionError({
            message: `Database connection failed: ${String(error)}`,
          }),
        ),
      ),
    )) as unknown as () => Effect.Effect<
    { readonly drizzle: DrizzleInstance },
    DatabaseConnectionError
  >,
)
