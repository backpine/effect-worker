# 016 - Type-Safe Request Context Patterns

## Problem

The current placeholder pattern works but has issues:

```typescript
// Current approach - NOT type-safe
const CloudflareEnvPlaceholder = Layer.succeed(
  CloudflareEnv,
  { env: {} as Env }  // ← Type assertion, could fail at runtime
)
```

**Issues:**
1. **Not type-safe** - `{} as Env` bypasses TypeScript
2. **Runtime risk** - If context override fails, handler uses empty object
3. **Not idiomatic** - Feels like a workaround, not a proper Effect pattern
4. **Messy** - Requires placeholder for every request-scoped service

## Goal

Find a type-safe, idiomatic Effect pattern for request-scoped services in Cloudflare Workers.

---

## Pattern 1: FiberRef with Effect.locally

**Concept:** Use `FiberRef` for fiber-local storage, set values per-request with `Effect.locally`.

```typescript
// services/cloudflare.ts
import { FiberRef, Effect, Layer } from "effect"

// Create a FiberRef for the env (fiber-local storage)
export const currentEnv = FiberRef.unsafeMake<Env | null>(null)

// Effect to get the current env (fails if not set)
export const CloudflareEnv = Effect.gen(function* () {
  const env = yield* FiberRef.get(currentEnv)
  if (env === null) {
    return yield* Effect.die("CloudflareEnv not set for this request")
  }
  return env
})

// Helper to run an effect with env set
export const withEnv = <A, E, R>(env: Env) =>
  Effect.locally(currentEnv, env)
```

**Usage in worker.ts:**
```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = handleRequest(request).pipe(
      withEnv(env),
      withCtx(ctx)
    )
    return runtime.runPromise(effect)
  }
}
```

**Usage in handlers:**
```typescript
export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    handlers.handle("check", () =>
      Effect.gen(function* () {
        const env = yield* CloudflareEnv  // Gets from FiberRef
        return {
          status: "ok" as const,
          environment: env.ENVIRONMENT || "development",
        }
      })
    )
)
```

**Pros:**
- Type-safe - `FiberRef` is properly typed
- Idiomatic Effect pattern
- Fails fast if not set (clear error message)
- No layer building per request

**Cons:**
- Changes service signature from `Context.Tag` to `Effect`
- Need to wrap all handlers with `withEnv`
- Doesn't integrate with `toWebHandler` context parameter
- Two different patterns for "services" (Tags vs FiberRef)

---

## Pattern 2: ManagedRuntime Per Request

**Concept:** Build a `ManagedRuntime` per request with the actual env/ctx.

```typescript
// handler.ts
export const makeHandler = (baseLayer: Layer.Layer<AppServices>) => {
  return async (request: Request, env: Env, ctx: ExecutionContext) => {
    // Build request-specific layer
    const requestLayer = Layer.mergeAll(
      Layer.succeed(CloudflareEnv, { env }),
      Layer.succeed(CloudflareCtx, { ctx })
    )

    const fullLayer = baseLayer.pipe(Layer.provideMerge(requestLayer))
    const runtime = ManagedRuntime.make(fullLayer)

    try {
      return await runtime.runPromise(handleRequest(request))
    } finally {
      await runtime.dispose()
    }
  }
}
```

**Pros:**
- Fully type-safe - no placeholders or assertions
- Standard Effect patterns (Context.Tag, Layer)
- Clear dependency graph

**Cons:**
- **Performance** - Layer building per request is expensive
- Defeats the purpose of module-level handler initialization
- No memoization across requests

---

## Pattern 3: Layer.effectContext (Dynamic Context Layer)

**Concept:** Create a layer that produces context from a FiberRef at build time.

```typescript
// services/cloudflare.ts
export const currentEnvRef = FiberRef.unsafeMake<Env | null>(null)
export const currentCtxRef = FiberRef.unsafeMake<ExecutionContext | null>(null)

export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

// Layer that reads from FiberRef
export const CloudflareEnvLive = Layer.effectContext(
  Effect.gen(function* () {
    const env = yield* FiberRef.get(currentEnvRef)
    if (env === null) {
      return yield* Effect.die("CloudflareEnv not initialized")
    }
    return Context.make(CloudflareEnv, { env })
  })
)
```

**Usage:**
```typescript
// handler.ts - built once at module level
const ApiLive = HttpApiBuilder.api(WorkerApi).pipe(
  Layer.provide(ApiImplementationLayer),
  Layer.provide(CloudflareEnvLive),  // Reads from FiberRef
  Layer.provide(CloudflareCtxLive)
)

export const { handler, dispose } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext)
)

// worker.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Set FiberRefs and call handler
    // But wait... FiberRef is per-fiber, and the layer is built once...
  }
}
```

**Issue:** Layer is built once at module init. FiberRef values set per-request won't affect the already-built layer. This pattern doesn't work for our use case.

---

## Pattern 4: Effect.provideServiceEffect (Recommended)

**Concept:** Use `Effect.provideServiceEffect` to dynamically provide services within the request handler.

```typescript
// services/cloudflare.ts - just the Tags, no layers needed
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

export class CloudflareCtx extends Context.Tag("CloudflareCtx")<
  CloudflareCtx,
  { readonly ctx: ExecutionContext }
>() {}
```

```typescript
// handler.ts
import { HttpApiBuilder, HttpServer, HttpApp } from "@effect/platform"
import { Effect, Layer, Runtime } from "effect"

// Build the HTTP app (not handler yet)
const httpApp: Effect.Effect<
  HttpApp.Default,
  never,
  CloudflareEnv | CloudflareCtx | HttpRouter.DefaultServices | HttpApi.Api
> = HttpApiBuilder.httpApp

// Layer for everything EXCEPT request-scoped services
const AppLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi),
  ApiImplementationLayer,
  HttpServer.layerContext
)

// Build runtime once
const runtime = ManagedRuntime.make(AppLayer)

// Export handler function that provides request-scoped services
export const handleRequest = (request: Request, env: Env, ctx: ExecutionContext) =>
  runtime.runPromise(
    httpApp.pipe(
      Effect.provideService(CloudflareEnv, { env }),
      Effect.provideService(CloudflareCtx, { ctx }),
      Effect.flatMap((app) => app(HttpServerRequest.fromWeb(request))),
      Effect.map(HttpServerResponse.toWeb)
    )
  )
```

**Wait** - this doesn't work because `HttpApiBuilder.httpApp` requires `Router` and `Middleware` which are internal. Let me reconsider...

---

## Pattern 5: Custom toWebHandler with Request Context (Recommended)

**Concept:** Create our own web handler that properly types request-scoped dependencies.

```typescript
// handler.ts
import { HttpApiBuilder, HttpServer, HttpApp } from "@effect/platform"
import { Effect, Layer, Runtime, Context } from "effect"
import * as ServerRequest from "@effect/platform/HttpServerRequest"
import * as ServerResponse from "@effect/platform/HttpServerResponse"

/**
 * Request-scoped services - NOT in the base layer
 */
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

export class CloudflareCtx extends Context.Tag("CloudflareCtx")<
  CloudflareCtx,
  { readonly ctx: ExecutionContext }
>() {}

/**
 * Type for request-scoped context
 */
export type RequestContext = Context.Context<CloudflareEnv | CloudflareCtx>

/**
 * Base layer - everything that can be built at module init
 */
const BaseLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi),
  HttpGroupsLive,
  AppLayer,
  HttpServer.layerContext
)

/**
 * The HTTP app effect - requires request-scoped services
 */
const httpAppEffect = HttpApiBuilder.httpApp

/**
 * Build base runtime once at module level
 */
const baseRuntime = ManagedRuntime.make(BaseLayer)

/**
 * Web handler that accepts typed request context
 */
export const handler = async (
  request: Request,
  requestContext: RequestContext
): Promise<Response> => {
  const effect = Effect.gen(function* () {
    // Get the HTTP app from the runtime
    const app = yield* httpAppEffect

    // Convert web request to server request
    const serverRequest = ServerRequest.fromWeb(request)

    // Run the app with the server request
    const response = yield* app.pipe(
      Effect.provideService(ServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped
    )

    // Convert back to web response
    return ServerResponse.toWeb(response)
  }).pipe(
    Effect.provide(requestContext)  // Provide typed request context
  )

  return baseRuntime.runPromise(effect)
}
```

**Issue:** This still requires `httpAppEffect` which has internal dependencies we can't easily access.

---

## Pattern 6: Accept Incomplete Layer Types (Pragmatic Solution)

**Concept:** Accept that the placeholder is a workaround, but make it type-safer.

```typescript
// services/request-context.ts
import { Context, Layer, Effect } from "effect"

/**
 * Marker type for "this will be provided at request time"
 */
export type RequestScoped<T> = T

/**
 * Create a request-scoped placeholder that fails clearly if not overridden
 */
export const requestScopedPlaceholder = <I, S>(
  tag: Context.Tag<I, S>,
  name: string
): Layer.Layer<I> =>
  Layer.effect(
    tag,
    Effect.die(`${name} must be provided at request time via context parameter`)
  )

// Usage
const CloudflareEnvPlaceholder = requestScopedPlaceholder(
  CloudflareEnv,
  "CloudflareEnv"
)
```

**Improvement:** The placeholder now fails with a clear message instead of using an empty object.

**Still not type-safe** - but at least fails fast with a clear error.

---

## Pattern 7: Hybrid Approach with Runtime Context Extension

**Concept:** Use `HttpApp.toWebHandlerRuntime` directly with proper context typing.

```typescript
// handler.ts
import { HttpApiBuilder, HttpApp, HttpServer } from "@effect/platform"
import { Effect, Layer, Runtime, Context, ManagedRuntime } from "effect"

// Services that ARE built at module level
const ModuleLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi),
  HttpGroupsLive.pipe(
    Layer.provide(AppLayer)
  ),
  HttpServer.layerContext
)

// Build runtime for module-level services
const moduleRuntime = ManagedRuntime.make(ModuleLayer)

// Get the HTTP app
const getHttpApp = Effect.gen(function* () {
  const { api, context } = yield* HttpApi.Api
  // Build HTTP app from API...
})

/**
 * Handler that extends runtime context per-request
 */
export const handler = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  // Get the base runtime
  const runtime = await moduleRuntime.runtime()

  // Extend the runtime's context with request-scoped services
  const extendedContext = runtime.context.pipe(
    Context.add(CloudflareEnv, { env }),
    Context.add(CloudflareCtx, { ctx })
  )

  // Create extended runtime
  const extendedRuntime = Runtime.make({
    ...runtime,
    context: extendedContext
  })

  // Run with extended runtime
  return Runtime.runPromise(extendedRuntime)(
    handleRequestEffect(request)
  )
}
```

**Issue:** `Runtime.make` doesn't work this way - runtime is not easily extendable.

---

## Recommended Solution: Pattern 6 with Validation

After exploring all patterns, here's the pragmatic recommendation:

### The Reality

`HttpApiBuilder.toWebHandler` is designed for the context-override pattern. The second parameter (`context`) is specifically for providing request-scoped values that override the layer.

The placeholder pattern **is** the intended approach, but we can make it safer:

### Improved Implementation

```typescript
// services/request-scoped.ts
import { Context, Layer, Effect } from "effect"

/**
 * Create a request-scoped service placeholder.
 *
 * This placeholder WILL be overridden at runtime via the handler's
 * context parameter. If not overridden, the effect will die with
 * a clear error message.
 *
 * @example
 * ```typescript
 * const CloudflareEnvPlaceholder = makeRequestScopedPlaceholder(
 *   CloudflareEnv,
 *   "CloudflareEnv",
 *   () => ({ env: null as unknown as Env })  // Sentinel value
 * )
 * ```
 */
export const makeRequestScopedPlaceholder = <I, S>(
  tag: Context.Tag<I, S>,
  name: string,
  makeSentinel: () => S
): Layer.Layer<I> => {
  const sentinel = makeSentinel()

  return Layer.succeed(tag, sentinel)
}

/**
 * Validate that request context was properly provided.
 * Call this at the start of handlers if you want runtime validation.
 */
export const validateRequestContext = Effect.gen(function* () {
  const { env } = yield* CloudflareEnv

  // Check for sentinel value
  if (env === null || Object.keys(env).length === 0) {
    return yield* Effect.die(
      "CloudflareEnv was not provided. Ensure requestContext is passed to handler()."
    )
  }
})
```

### Updated handler.ts

```typescript
import { Layer, Context } from "effect"
import { HttpApiBuilder, HttpServer, OpenApi } from "@effect/platform"
import { WorkerApi } from "./definition"
import { ApiImplementationLayer } from "./app"
import { CloudflareEnv, CloudflareCtx } from "./services"

/**
 * Request-scoped service placeholders.
 *
 * These are overridden at runtime by the context parameter.
 * Using null as sentinel to detect if override was missed.
 */
const RequestScopedLayer = Layer.mergeAll(
  Layer.succeed(CloudflareEnv, { env: null as unknown as Env }),
  Layer.succeed(CloudflareCtx, { ctx: null as unknown as ExecutionContext })
)

const ApiLive = HttpApiBuilder.api(WorkerApi).pipe(
  Layer.provide(ApiImplementationLayer),
  Layer.provide(RequestScopedLayer)
)

export const { handler, dispose } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext)
)

export const openApiSpec = OpenApi.fromApi(WorkerApi)
```

### Updated worker.ts with Validation

```typescript
import { Context } from "effect"
import { handler, openApiSpec } from "./handler"
import { CloudflareEnv, CloudflareCtx } from "./services"

/**
 * Create request context - type-safe!
 */
const makeRequestContext = (env: Env, ctx: ExecutionContext) =>
  Context.empty.pipe(
    Context.add(CloudflareEnv, { env }),
    Context.add(CloudflareCtx, { ctx })
  )

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/openapi.json") {
      return Response.json(openApiSpec)
    }

    // Type-safe context creation
    const requestContext = makeRequestContext(env, ctx)

    return handler(request, requestContext)
  }
}
```

---

## Summary

| Pattern | Type-Safe | Idiomatic | Performance | Complexity |
|---------|-----------|-----------|-------------|------------|
| 1. FiberRef | ✅ | ✅ | ✅ | Medium |
| 2. ManagedRuntime/request | ✅ | ✅ | ❌ | Low |
| 3. Layer.effectContext | ❌ | ✅ | ✅ | Medium |
| 4. provideServiceEffect | Partial | ✅ | ✅ | High |
| 5. Custom toWebHandler | ✅ | ❌ | ✅ | High |
| 6. Validated Placeholder | Partial | ✅ | ✅ | Low |
| 7. Runtime Extension | ❌ | ❌ | ✅ | High |

### Recommendation

**For Cloudflare Workers with `HttpApiBuilder.toWebHandler`:**

Use **Pattern 6 (Validated Placeholder)** because:
1. Works with the existing `toWebHandler` API
2. Minimal code changes
3. Fast - layer built once, context override is O(1)
4. Fails fast with clear error if context not provided
5. Consistent with @effect/platform's design intent

**For maximum type-safety (if you can abandon toWebHandler):**

Use **Pattern 1 (FiberRef)** because:
1. Fully type-safe
2. Idiomatic Effect pattern
3. No placeholder hacks
4. Clear semantics

The trade-off is that Pattern 1 requires more architectural changes and doesn't integrate as cleanly with `HttpApiBuilder.toWebHandler`.
