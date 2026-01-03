/**
 * Health Check Endpoint Handlers
 *
 * Handler implementations for the health endpoint.
 *
 * ## Accessing Request-Scoped Services
 *
 * Services are provided by middleware and accessed via standard Effect pattern:
 *
 * ```typescript
 * const { env } = yield* CloudflareBindings
 * const { drizzle } = yield* DatabaseService
 * ```
 *
 * @module
 */
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { CloudflareBindings } from "@/services/cloudflare"
import { WorkerApi } from "@/http/api"

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
          // Access CloudflareBindings service (provided by middleware)
          const { env } = yield* CloudflareBindings

          return {
            status: "ok" as const,
            timestamp: new Date().toISOString(),
            environment: env.ENVIRONMENT || "development",
          }
        }),
      )
    }),
)
