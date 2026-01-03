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
 *   └─> withCloudflareBindings(env, ctx)
 *         └─> handleRequest(request)
 *               └─> Middleware chain:
 *                     ├─> CloudflareBindingsMiddleware → provides env/ctx
 *                     └─> DatabaseMiddleware → provides drizzle
 *                           └─> Handler accesses services via:
 *                                 - yield* CloudflareBindings
 *                                 - yield* DatabaseService
 * ```
 *
 * ## Middleware-Based Request-Scoped Services
 *
 * Services are provided via HttpApiMiddleware:
 * - CloudflareBindingsMiddleware: Provides env/ctx from FiberRef
 * - DatabaseMiddleware: Creates per-request database connection
 *
 * Handlers access services using standard Effect pattern: `yield* ServiceTag`
 *
 * @module
 */
import { runtime, handleRequest, openApiSpec } from "@/runtime";
import { withCloudflareBindings } from "@/services/cloudflare";
import { makeQueueHandler } from "@/queue";
import { ExampleEvent, handleExampleEvent } from "@/queue/handlers/example";

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

    // Handle request with Cloudflare bindings available via FiberRef
    // Middleware handles database connection per-request
    const effect = handleRequest(request).pipe(
      withCloudflareBindings(env, ctx),
    );

    return runtime.runPromise(effect);
  },
  queue: makeQueueHandler({
    schema: ExampleEvent,
    handler: handleExampleEvent,
    concurrency: 5,
  }),
} satisfies ExportedHandler<Env>;
