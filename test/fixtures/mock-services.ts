/**
 * Mock Services for Testing
 *
 * Provides mock implementations of Cloudflare services for unit tests.
 *
 * @module
 */
import { Effect } from "effect"
import { withCloudflareBindings } from "@/services"

/**
 * Mock Cloudflare Environment for tests.
 */
export const mockEnv = {
  ENVIRONMENT: "test",
  LOG_LEVEL: "debug",
  API_KEY: "test-api-key",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
} as unknown as Env

/**
 * Mock Execution Context for tests.
 */
export const mockCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

/**
 * Wrap an effect with mock Cloudflare environment and context.
 *
 * Use this in tests to provide request-scoped data.
 *
 * @example
 * ```typescript
 * const result = await Effect.runPromise(
 *   myEffect.pipe(withMockCloudflare)
 * )
 * ```
 */
export const withMockCloudflare = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(withCloudflareBindings(mockEnv, mockCtx))
