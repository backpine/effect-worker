/**
 * Cloudflare Worker Entry Point
 *
 * This is the main entry point for the Cloudflare Worker. It exports a default
 * object with a `fetch` handler that processes incoming HTTP requests.
 *
 * ## Cloudflare Runtime Constraints
 *
 * - **No global state**: Each request runs in an isolated context. While the
 *   Worker runtime may reuse the same isolate, you cannot rely on global state
 *   persisting between requests.
 *
 * - **Request-scoped bindings**: Cloudflare's `env` (KV, D1, R2, etc.) and
 *   `ExecutionContext` are only available during request handling, not at
 *   module initialization time.
 *
 * - **Limited CPU time**: Workers have 10-30ms CPU time limits. Long-running
 *   computations should be avoided or broken into smaller chunks.
 *
 * ## Request Flow
 *
 * ```
 * fetch(request, env, ctx)
 *   └─> withRequestScope(env, ctx)
 *         ├─> withDatabase(env.DATABASE_URL)
 *         ├─> withEnv(env)
 *         └─> withCtx(ctx)
 *               └─> handleRequest(request)
 *                     └─> Handler accesses services via:
 *                           - getDrizzle (database)
 *                           - getEnv (Cloudflare bindings)
 *                           - getCtx (ExecutionContext)
 * ```
 *
 * ## Why FiberRef for Request-Scoped Data?
 *
 * We use FiberRef instead of Effect's Layer/Context.Tag pattern because:
 *
 * 1. **Layer memoization**: ManagedRuntime builds layers ONCE at startup.
 *    Cloudflare bindings aren't available at startup, only at request time.
 *
 * 2. **Per-request isolation**: FiberRef + Effect.locally ensures each request
 *    has its own isolated values, even when running on the same runtime.
 *
 * 3. **Type safety without placeholders**: Using FiberRef avoids the need for
 *    placeholder layers that would require "as any" casts.
 *
 * @module
 */
import { Effect } from "effect";
import { runtime, handleRequest, openApiSpec } from "@/runtime";
import { withDatabase, withEnv, withCtx } from "@/services";

/**
 * Wrap an effect with all request-scoped resources.
 *
 * Provides per-request:
 * - Database connection (opened per request, closed when scope ends)
 * - Cloudflare env (via FiberRef)
 * - Cloudflare execution context (via FiberRef)
 */
/**
 * Local development database URL (used when env.DATABASE_URL is not set).
 */
const LOCAL_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/effect_worker";

const withRequestScope =
  (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      withDatabase(env.DATABASE_URL ?? LOCAL_DATABASE_URL),
      withEnv(env),
      withCtx(ctx),
    );

/**
 * Cloudflare Worker fetch handler.
 *
 * This is the entry point for all HTTP requests to the Worker.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Serve OpenAPI spec at /api/openapi.json
    if (url.pathname === "/api/openapi.json") {
      return Response.json(openApiSpec);
    }

    // Handle all other requests through the Effect runtime
    const effect = handleRequest(request).pipe(withRequestScope(env, ctx));
    return runtime.runPromise(effect);
  },
};
