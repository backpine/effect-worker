# 014 - Simplified Web Handler for Cloudflare Workers

## Problem

The current `handler.ts` implementation is overcomplicated:

1. **Manual request/response conversion** - Calls `HttpServerRequest.fromWeb()` and `HttpServerResponse.toWeb()` manually
2. **Custom WorkerPlatformLayer** - 25+ lines of stub implementations for FileSystem, Path, Etag, HttpPlatform
3. **Manual effect orchestration** - Gets app from `routerEffect`, provides request, scopes, converts response
4. **Uses HttpLayerRouter** - Requires more dependencies than necessary for a pure API server

Compare to the simple pattern that works:

```typescript
const HttpLive = Http.router.empty.pipe(
  Http.router.get("/", Http.response.text("Hello World")),
  Http.app.toWebHandler
);

export default {
  async fetch(request: Request) {
    return await HttpLive(request);
  }
};
```

## Solution

Use `HttpApiBuilder.toWebHandler()` with `HttpServer.layerContext` - Effect's official approach for serverless/edge runtimes.

### Key Discovery

1. **`HttpServer.layerContext`** - Provides stub implementations for `HttpPlatform`, `FileSystem`, `Etag.Generator`, and `Path`. This replaces the custom `WorkerPlatformLayer`.

2. **`HttpApiBuilder.toWebHandler()`** - Converts an API layer directly to a web handler function. Returns `{ handler, dispose }` where handler is `(request: Request, context?: Context) => Promise<Response>`.

3. **Context parameter** - The handler's second parameter accepts additional context that gets merged into the runtime. This enables request-scoped services (CloudflareEnv, CloudflareCtx) without baking them into the layer.

## Implementation

### New handler.ts

```typescript
import { Layer } from "effect"
import { HttpApiBuilder, HttpServer, OpenApi } from "@effect/platform"
import { WorkerApi } from "./definition"
import { ApiImplementationLayer } from "./app"
import { CloudflareEnv, CloudflareCtx } from "./services"

/**
 * Placeholder layers for request-scoped services.
 *
 * These are overridden at runtime by the context parameter passed to handler().
 * The context merging in HttpApp.toWebHandlerRuntime replaces these values.
 */
const CloudflareEnvPlaceholder = Layer.succeed(
  CloudflareEnv,
  { env: {} as Env }
)

const CloudflareCtxPlaceholder = Layer.succeed(
  CloudflareCtx,
  { ctx: {} as ExecutionContext }
)

/**
 * API Layer
 *
 * Combines the WorkerApi definition with its implementation.
 */
const ApiLive = HttpApiBuilder.api(WorkerApi).pipe(
  Layer.provide(ApiImplementationLayer),
  Layer.provide(CloudflareEnvPlaceholder),
  Layer.provide(CloudflareCtxPlaceholder)
)

/**
 * Web Handler
 *
 * Built ONCE at module initialization.
 * Uses HttpServer.layerContext for serverless-compatible platform stubs.
 */
export const { handler, dispose } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext)
)

/**
 * OpenAPI specification
 */
export const openApiSpec = OpenApi.fromApi(WorkerApi)
```

### Request-Scoped Service Pattern

The key insight is that `toWebHandler` requires all layer dependencies to be satisfied at build time, but the context parameter can override services at runtime.

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer Build Time (module init)                                   │
│                                                                  │
│   CloudflareEnvPlaceholder ──► { env: {} }  (dummy value)        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Request Time                                                     │
│                                                                  │
│   handler(request, Context.make(CloudflareEnv, { env }))        │
│                     │                                            │
│                     ▼                                            │
│   Context merging overrides placeholder with real env            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### New worker.ts

```typescript
import { Context } from "effect"
import { handler } from "./handler"
import { CloudflareEnv, CloudflareCtx } from "./services"

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Create request-scoped context
    const requestContext = Context.make(CloudflareEnv, { env }).pipe(
      Context.add(CloudflareCtx, { ctx })
    )

    // Pass context as second parameter - merged into runtime
    return handler(request, requestContext)
  }
}
```

## What Gets Removed

1. **`WorkerPlatformLayer`** (25+ lines) - Replaced by `HttpServer.layerContext`
2. **`handleRequest` function** (20+ lines) - Replaced by `handler` from `toWebHandler`
3. **Manual `HttpServerRequest.fromWeb()`** - Handled internally
4. **Manual `HttpServerResponse.toWeb()`** - Handled internally
5. **`HttpLayerRouter.toHttpEffect()`** - Not needed
6. **`ManagedRuntime`** - Handler manages its own runtime

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| Lines of code | ~70 in handler.ts | ~20 in handler.ts |
| Platform layer | Custom 25-line stub | Single import |
| Request handling | Manual 20-line effect | Single function call |
| Runtime management | Manual ManagedRuntime | Automatic |
| Request/response conversion | Manual | Automatic |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│ Module Initialization (ONCE per isolate)                │
│                                                         │
│  WorkerApi ──┐                                          │
│              │                                          │
│  HttpGroupsLive ──┼──► ApiLive ──┐                      │
│              │                   │                      │
│  AppLayer ───┘                   │                      │
│                                  ▼                      │
│  HttpServer.layerContext ──► toWebHandler ──► handler   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Per Request                                             │
│                                                         │
│  Request ──┐                                            │
│            │                                            │
│  env ──────┼──► Context.make(CloudflareEnv, { env })    │
│            │              │                             │
│  ctx ──────┘              ▼                             │
│                    handler(request, context)            │
│                              │                          │
│                              ▼                          │
│                          Response                       │
└─────────────────────────────────────────────────────────┘
```

## How Context Injection Works

From `HttpApp.toWebHandlerRuntime` (lines 225-229):

```typescript
const contextMap = new Map<string, any>(runtime.context.unsafeMap)
if (Context.isContext(context)) {
  for (const [key, value] of context.unsafeMap) {
    contextMap.set(key, value)
  }
}
```

The handler merges any provided context into the runtime's context map before running the effect. This is O(1) - just adds to the map.

## OpenAPI Endpoint

To add the OpenAPI JSON endpoint, you have two options:

### Option A: Add to API definition

```typescript
// In definition/WorkerApi.ts
export class WorkerApi extends HttpApi.make("WorkerApi")
  .add(Groups.HealthGroup)
  .add(Groups.UsersGroup)
  .prefix("/api")
{}

// OpenAPI is auto-generated - access via HttpApiBuilder if needed
```

### Option B: Use middleware or separate handler

```typescript
// Simple approach: check path before calling handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname === "/api/openapi.json") {
      return Response.json(OpenApi.fromApi(WorkerApi))
    }

    const requestContext = Context.make(CloudflareEnv, { env }).pipe(
      Context.add(CloudflareCtx, { ctx })
    )
    return handler(request, requestContext)
  }
}
```

## Migration Steps

1. Update `handler.ts`:
   - Remove `WorkerPlatformLayer`
   - Remove `handleRequest` function
   - Remove `HttpLayerRouter` imports
   - Add `HttpApiBuilder.toWebHandler` with `HttpServer.layerContext`
   - Export `{ handler, dispose }`

2. Update `worker.ts`:
   - Remove `ManagedRuntime`
   - Import `handler` from `./handler`
   - Pass `requestContext` as second parameter to `handler`

3. Update `app.ts`:
   - Keep `AppLayer` and `ApiImplementationLayer` as-is (or simplify if desired)

## Comparison with Original Example

The user's working example:

```typescript
const HttpLive = Http.router.empty.pipe(
  Http.router.get("/", Http.response.text("Hello World")),
  Http.app.toWebHandler
);

export default {
  async fetch(request: Request) {
    return await HttpLive(request);
  }
};
```

Our new approach achieves the same simplicity while keeping:
- **HttpApi definition/implementation separation** - Schema-first API design
- **Type-safe request handling** - Path params, query params, payloads all typed
- **Automatic validation** - Via Effect Schema
- **OpenAPI generation** - From API definition
- **Error handling** - Tagged errors with HTTP status annotations
- **Service injection** - Via Effect's layer system

## Conclusion

By using `HttpApiBuilder.toWebHandler()` with `HttpServer.layerContext`, we get:

1. **Simplicity** - Handler is a single function call
2. **Correctness** - Uses Effect's official serverless support
3. **Type safety** - Keeps all the benefits of HttpApiBuilder
4. **Performance** - Layer built once, context injection is O(1)
5. **Maintainability** - Less custom code to maintain
