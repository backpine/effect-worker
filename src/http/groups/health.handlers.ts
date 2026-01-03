/**
 * Health Check Endpoint Handlers
 *
 * Handler implementations for the health endpoint.
 *
 * ## Accessing Request-Scoped Services
 *
 * In Cloudflare Workers, we use FiberRef-based accessors instead of the
 * typical Effect Context.Tag pattern:
 *
 * ```typescript
 * // DON'T: Creates layer dependency, breaks ManagedRuntime
 * const drizzle = yield* PgDrizzle.PgDrizzle
 *
 * // DO: Reads from FiberRef, no layer dependency
 * const drizzle = yield* getDrizzle
 * ```
 *
 * This is because ManagedRuntime memoizes layers at startup, but Cloudflare
 * bindings and database connections must be created per-request.
 *
 * @module
 */
import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { getEnv } from "@/services";
import { WorkerApi } from "@/http/api";

/**
 * Health endpoint handler implementation.
 */
export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    Effect.gen(function* () {
      return handlers.handle("check", () =>
        Effect.gen(function* () {
          const env = yield* getEnv;

          return {
            status: "ok" as const,
            timestamp: new Date().toISOString(),
            environment: env.ENVIRONMENT || "development",
          };
        }),
      );
    }),
);
