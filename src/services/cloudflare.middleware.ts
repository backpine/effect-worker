/**
 * Cloudflare Bindings Middleware
 *
 * Provides Cloudflare's `env` and `ExecutionContext` to handlers via HttpApiMiddleware.
 *
 * ## Why Middleware?
 *
 * Cloudflare Workers provide `env` and `ctx` at request time, not at module init.
 * HttpApiMiddleware runs per-request, making it the perfect mechanism to inject
 * these bindings into the Effect context.
 *
 * ## Architecture
 *
 * ```
 * Entry Point (index.ts)
 *     │
 *     ├─→ Sets FiberRef with env/ctx (withCloudflareBindings)
 *     │
 *     ▼
 * CloudflareBindingsMiddleware (runs per-request)
 *     │
 *     ├─→ Reads from FiberRef
 *     ├─→ Provides CloudflareBindings service to handlers
 *     │
 *     ▼
 * Handler
 *     └─→ yield* CloudflareBindings
 * ```
 *
 * @module
 */
import { HttpApiMiddleware, HttpApiSchema } from "@effect/platform"
import { Context, Effect, FiberRef, Layer, Schema as S } from "effect"

// ============================================================================
// Service Definition
// ============================================================================

/**
 * CloudflareBindings service provides access to Cloudflare's env and ctx.
 *
 * @example
 * ```typescript
 * const { env, ctx } = yield* CloudflareBindings
 * const value = await env.MY_KV.get("key")
 * ctx.waitUntil(backgroundTask())
 * ```
 */
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  { readonly env: Env; readonly ctx: ExecutionContext }
>() {}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error when Cloudflare bindings are not available.
 *
 * This indicates a programming error - the middleware should always have
 * access to bindings when running in a Cloudflare Worker context.
 */
export class CloudflareBindingsError extends S.TaggedError<CloudflareBindingsError>()(
  "CloudflareBindingsError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// ============================================================================
// Middleware Definition
// ============================================================================

/**
 * Middleware that provides CloudflareBindings to handlers.
 *
 * Apply this at the API level to make env/ctx available everywhere:
 *
 * ```typescript
 * export class WorkerApi extends HttpApi.make("WorkerApi")
 *   .add(UsersGroup)
 *   .middleware(CloudflareBindingsMiddleware)
 *   .prefix("/api") {}
 * ```
 */
export class CloudflareBindingsMiddleware extends HttpApiMiddleware.Tag<CloudflareBindingsMiddleware>()(
  "CloudflareBindingsMiddleware",
  {
    failure: CloudflareBindingsError,
    provides: CloudflareBindings,
  },
) {}

// ============================================================================
// FiberRef Bridge (Entry Point → Middleware)
// ============================================================================

/**
 * FiberRef holding the current request's Cloudflare environment bindings.
 *
 * This bridges the gap between the Worker entry point (outside Effect) and
 * the middleware (inside Effect).
 */
export const currentEnv = FiberRef.unsafeMake<Env | null>(null)

/**
 * FiberRef holding the current request's ExecutionContext.
 */
export const currentCtx = FiberRef.unsafeMake<ExecutionContext | null>(null)

/**
 * Set Cloudflare bindings for the scope of an effect.
 *
 * Call this at the request boundary in index.ts:
 *
 * ```typescript
 * const effect = handleRequest(request).pipe(
 *   withCloudflareBindings(env, ctx),
 * )
 * return runtime.runPromise(effect)
 * ```
 */
export const withCloudflareBindings = (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.locally(currentEnv, env),
      Effect.locally(currentCtx, ctx),
    )

// ============================================================================
// Middleware Implementation
// ============================================================================

/**
 * Live implementation of CloudflareBindingsMiddleware.
 *
 * Reads env/ctx from FiberRef and provides them as the CloudflareBindings service.
 */
export const CloudflareBindingsMiddlewareLive = Layer.effect(
  CloudflareBindingsMiddleware,
  Effect.gen(function* () {
    // Return the middleware effect (runs per-request)
    return Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv)
      const ctx = yield* FiberRef.get(currentCtx)

      if (env === null || ctx === null) {
        return yield* Effect.fail(
          new CloudflareBindingsError({
            message: "Cloudflare bindings not available. Ensure withCloudflareBindings() wraps the handler.",
          }),
        )
      }

      return { env, ctx }
    })
  }),
)

// ============================================================================
// Utilities
// ============================================================================

/**
 * Schedule a background task that runs after the response is sent.
 *
 * Uses ctx.waitUntil() to keep the Worker alive while the effect runs.
 * Errors are logged but don't affect the response.
 *
 * @example
 * ```typescript
 * yield* waitUntil(
 *   Effect.gen(function* () {
 *     yield* sendAnalytics(event)
 *   })
 * )
 * ```
 */
export const waitUntil = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void, never, CloudflareBindings> =>
  Effect.gen(function* () {
    const { ctx } = yield* CloudflareBindings
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.catchAll(() => Effect.void),
        ),
      ),
    )
  })
