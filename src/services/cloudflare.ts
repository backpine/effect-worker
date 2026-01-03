/**
 * Cloudflare Request-Scoped Services
 *
 * Provides access to Cloudflare's `env` and `ExecutionContext` bindings
 * using Effect's FiberRef pattern.
 *
 * ## Why FiberRef Instead of Context.Tag?
 *
 * In a typical Effect application, you'd use Context.Tag + Layer:
 *
 * ```typescript
 * class CloudflareEnv extends Context.Tag("CloudflareEnv")<...>() {
 *   static layer = (env: Env) => Layer.succeed(this, { env })
 * }
 * ```
 *
 * This doesn't work with Cloudflare Workers because:
 *
 * 1. **Layer memoization**: ManagedRuntime builds layers at startup, but
 *    Cloudflare bindings aren't available until request time.
 *
 * 2. **Request isolation**: Layers are shared across requests. If we somehow
 *    injected `env` into a layer, all concurrent requests would see the same
 *    env (the first request's env).
 *
 * 3. **Type requirements**: Using Context.Tag in handlers creates a layer
 *    dependency (R type). This prevents using ManagedRuntime.make(ApiLayer)
 *    because the layer would require CloudflareEnv.
 *
 * ## FiberRef Solution
 *
 * FiberRef provides fiber-local storage that works with Effect.locally:
 *
 * ```typescript
 * // Set value for the scope of this effect
 * Effect.locally(currentEnv, env)(myEffect)
 *
 * // Read value inside the effect
 * const env = yield* FiberRef.get(currentEnv)
 * ```
 *
 * This ensures:
 * - Each request has its own isolated env/ctx values
 * - No layer dependencies (handlers have R = never)
 * - ManagedRuntime can be used for static services
 *
 * @module
 */
import { Effect, FiberRef } from "effect"

// ============================================================================
// FiberRefs for Request-Scoped Data
// ============================================================================

/**
 * FiberRef holding the current request's Cloudflare environment bindings.
 *
 * Contains KV namespaces, D1 databases, R2 buckets, secrets, and other
 * bindings defined in wrangler.toml.
 */
export const currentEnv = FiberRef.unsafeMake<Env | null>(null)

/**
 * FiberRef holding the current request's ExecutionContext.
 *
 * Used for ctx.waitUntil() to schedule background work after response.
 */
export const currentCtx = FiberRef.unsafeMake<ExecutionContext | null>(null)

// ============================================================================
// Accessors (Use These in Handlers)
// ============================================================================

/**
 * Get the current Cloudflare environment bindings.
 *
 * Dies if called outside of withEnv() scope (programming error).
 *
 * @example
 * ```typescript
 * const env = yield* getEnv
 * const value = await env.MY_KV.get("key")
 * ```
 */
export const getEnv = Effect.gen(function* () {
  const env = yield* FiberRef.get(currentEnv)
  if (env === null) {
    return yield* Effect.die(
      "Cloudflare env not set. Ensure withEnv() wraps the handler.",
    )
  }
  return env
})

/**
 * Get the current Cloudflare ExecutionContext.
 *
 * @example
 * ```typescript
 * const ctx = yield* getCtx
 * ctx.waitUntil(backgroundWork())
 * ```
 */
export const getCtx = Effect.gen(function* () {
  const ctx = yield* FiberRef.get(currentCtx)
  if (ctx === null) {
    return yield* Effect.die(
      "Cloudflare ctx not set. Ensure withCtx() wraps the handler.",
    )
  }
  return ctx
})

// ============================================================================
// Wrappers (Use at Request Boundary)
// ============================================================================

/**
 * Set Cloudflare env for the scope of an effect.
 *
 * Call this at the request boundary (in index.ts fetch handler).
 */
export const withEnv = (env: Env) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.locally(currentEnv, env)(effect)

/**
 * Set Cloudflare ExecutionContext for the scope of an effect.
 *
 * Call this at the request boundary (in index.ts fetch handler).
 */
export const withCtx = (ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.locally(currentCtx, ctx)(effect)

// ============================================================================
// Utilities
// ============================================================================

/**
 * Schedule a background task that runs after the response is sent.
 *
 * Uses ctx.waitUntil() to keep the Worker alive while the effect runs.
 * Errors are logged but don't affect the response.
 *
 * ## Cloudflare Worker Lifecycle
 *
 * Normally, a Worker terminates as soon as the Response is returned.
 * ctx.waitUntil() tells Cloudflare to keep the Worker alive until the
 * provided Promise resolves.
 *
 * Common use cases:
 * - Analytics/logging that shouldn't block the response
 * - Cache warming
 * - Webhook notifications
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
export const waitUntil = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ctx = yield* getCtx
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.catchAll(() => Effect.void),
        ),
      ),
    )
  })
