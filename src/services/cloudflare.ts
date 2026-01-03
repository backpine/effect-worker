/**
 * Cloudflare Bindings Service
 *
 * Provides access to Cloudflare's `env` and `ExecutionContext` bindings.
 *
 * ## Usage
 *
 * In handlers (HTTP or Queue):
 * ```typescript
 * const { env, ctx } = yield* CloudflareBindings
 * const value = await env.MY_KV.get("key")
 * ctx.waitUntil(backgroundTask())
 * ```
 *
 * At entry point:
 * ```typescript
 * effect.pipe(withCloudflareBindings(env, ctx))
 * ```
 *
 * @module
 */
import { Context, Effect, FiberRef, Schema as S } from "effect";
import { HttpApiSchema } from "@effect/platform";

// ============================================================================
// Service Definition
// ============================================================================

/**
 * CloudflareBindings service provides access to Cloudflare's env and ctx.
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
 */
export class CloudflareBindingsError extends S.TaggedError<CloudflareBindingsError>()(
  "CloudflareBindingsError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// ============================================================================
// FiberRef Bridge (Entry Point → Effect Context)
// ============================================================================

/**
 * FiberRef holding the current request's Cloudflare environment bindings.
 */
export const currentEnv = FiberRef.unsafeMake<Env | null>(null);

/**
 * FiberRef holding the current request's ExecutionContext.
 */
export const currentCtx = FiberRef.unsafeMake<ExecutionContext | null>(null);

/**
 * Set Cloudflare bindings for the scope of an effect.
 *
 * Call this at the request/batch boundary in index.ts:
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
    );

// ============================================================================
// Utilities
// ============================================================================

/**
 * Schedule a background task that runs after the response is sent.
 *
 * Uses ctx.waitUntil() to keep the Worker alive while the effect runs.
 * Errors are logged but don't affect the response.
 */
export const waitUntil = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<void, never, CloudflareBindings> =>
  Effect.gen(function* () {
    const { ctx } = yield* CloudflareBindings;
    ctx.waitUntil(
      Effect.runPromise(
        effect.pipe(
          Effect.tapErrorCause(Effect.logError),
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );
  });
