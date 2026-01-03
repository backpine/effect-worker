/**
 * Database HTTP Middleware
 *
 * HttpApiMiddleware that provides DatabaseService to HTTP handlers.
 * Creates a fresh database connection per-request.
 *
 * @module
 */
import { HttpApiMiddleware } from "@effect/platform";
import { Effect, FiberRef, Layer } from "effect";
import {
  DatabaseService,
  DatabaseConnectionError,
  makeDatabaseConnection,
  LOCAL_DATABASE_URL,
} from "@/services/database";
import { currentEnv } from "@/services/cloudflare";

// ============================================================================
// Middleware Definition
// ============================================================================

/**
 * Middleware that provides DatabaseService to HTTP handlers.
 *
 * Apply to groups that need database access:
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
// Middleware Implementation
// ============================================================================

/**
 * Live implementation of DatabaseMiddleware.
 *
 * Creates a scoped database connection per-request.
 * The connection is automatically closed when the request scope ends.
 */
export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    // Return the middleware effect (runs per-request)
    return Effect.gen(function* () {
      // Get connection string from Cloudflare env via FiberRef
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
      return yield* makeDatabaseConnection(connectionString);
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
