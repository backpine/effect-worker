/**
 * Effect Runtime Configuration
 *
 * This module sets up the ManagedRuntime for handling HTTP requests.
 *
 * ## Why ManagedRuntime?
 *
 * ManagedRuntime provides layer memoization, meaning services are built once
 * and reused across requests. This is efficient for:
 *
 * - Router configuration (static, doesn't change per-request)
 * - Middleware setup (static)
 * - OpenAPI generation (static)
 *
 * ## What About Request-Scoped Services?
 *
 * Request-scoped services (database, Cloudflare env) are NOT part of the
 * ManagedRuntime layer. Instead, they're provided via FiberRef + Effect.locally
 * in the request handler (see src/index.ts).
 *
 * This separation ensures:
 * - Static services: Built once, reused (efficient)
 * - Request-scoped services: Created per-request (isolated)
 *
 * ## Layer Composition
 *
 * ```
 * ApiLayer (built once at startup)
 * ├── HttpApiBuilder.api(WorkerApi)
 * │   └── HttpGroupsLive (handler implementations)
 * ├── HttpApiBuilder.Router.Live
 * ├── HttpApiBuilder.Middleware.layer
 * └── HttpServer.layerContext
 *
 * Request-scoped (provided per-request via FiberRef)
 * ├── withDatabase() → getDrizzle
 * ├── withEnv() → getEnv
 * └── withCtx() → getCtx
 * ```
 *
 * @module
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpApiBuilder, HttpServer, OpenApi } from "@effect/platform"
import * as ServerRequest from "@effect/platform/HttpServerRequest"
import * as ServerResponse from "@effect/platform/HttpServerResponse"
import { WorkerApi, HttpGroupsLive } from "@/http"

/**
 * API Layer combining static services.
 *
 * These layers are memoized by ManagedRuntime - built once at startup.
 * Request-scoped services are provided separately via FiberRef.
 */
const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi).pipe(Layer.provide(HttpGroupsLive)),
  HttpApiBuilder.Router.Live,
  HttpApiBuilder.Middleware.layer,
  HttpServer.layerContext,
)

/**
 * Shared runtime instance.
 *
 * Built once at module initialization. Layers are memoized, so subsequent
 * calls to runPromise reuse the same service instances.
 */
export const runtime = ManagedRuntime.make(ApiLayer)

/**
 * Handle an incoming HTTP request.
 *
 * Returns an Effect that can be wrapped with request-scoped services
 * (database, Cloudflare env/ctx) before execution.
 *
 * ## Usage
 *
 * ```typescript
 * const effect = handleRequest(request).pipe(
 *   withDatabase(env.DATABASE_URL),
 *   withEnv(env),
 *   withCtx(ctx),
 * )
 * return runtime.runPromise(effect)
 * ```
 */
export const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    const app = yield* HttpApiBuilder.httpApp
    const serverRequest = ServerRequest.fromWeb(request)
    const url = new URL(request.url)

    const response = yield* app.pipe(
      Effect.provideService(ServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped,
      Effect.catchAll(() =>
        ServerResponse.json(
          {
            _tag: "NotFoundError",
            path: url.pathname,
            message: `Route not found: ${request.method} ${url.pathname}`,
          },
          { status: 404 },
        ),
      ),
    )

    return ServerResponse.toWeb(response)
  })

/**
 * OpenAPI specification for the API.
 *
 * Generated from the WorkerApi definition. Serve this at /api/openapi.json
 * for API documentation and client generation.
 */
export const openApiSpec = OpenApi.fromApi(WorkerApi)
