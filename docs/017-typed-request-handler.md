# 017 - Type-Safe Request Handler

## The Real Problem

Looking at `HttpApp.toWebHandlerRuntime`, the handler signature is:

```typescript
(request: Request, context?: Context.Context<never> | undefined) => Promise<Response>
```

The `Context<never>` means TypeScript **doesn't track** what services must be provided. This is why our placeholder pattern "works" at runtime but isn't type-safe.

## Solution: Typed Web Handler Wrapper

Create a wrapper that properly types request-scoped services.

### Implementation

```typescript
// src/lib/typed-web-handler.ts
import { Context, Effect, Layer, ManagedRuntime, Runtime, Scope } from "effect"
import {
  HttpApp,
  HttpApiBuilder,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import type { HttpApi } from "@effect/platform"

/**
 * Configuration for creating a typed web handler
 */
export interface TypedWebHandlerConfig<
  BaseServices,
  RequestServices,
  ApiDef extends HttpApi.HttpApi.Any
> {
  /** The HttpApi definition */
  api: ApiDef

  /** Layer providing base services (built once at module init) */
  baseLayer: Layer.Layer<BaseServices, never, never>

  /** Layer providing API group implementations */
  apiLayer: Layer.Layer<
    HttpApiBuilder.HttpApiBuilder.ApiImplementation<ApiDef>,
    never,
    BaseServices | RequestServices
  >
}

/**
 * Result of creating a typed web handler
 */
export interface TypedWebHandler<RequestServices> {
  /**
   * Handle a request with typed request-scoped context.
   * TypeScript enforces that all RequestServices are provided.
   */
  handler: (
    request: Request,
    context: Context.Context<RequestServices>
  ) => Promise<Response>

  /** Dispose of resources */
  dispose: () => Promise<void>
}

/**
 * Create a type-safe web handler that separates:
 * - Base services (built once at module init)
 * - Request-scoped services (must be provided per-request)
 */
export const makeTypedWebHandler = <
  BaseServices,
  RequestServices,
  ApiDef extends HttpApi.HttpApi.Any
>(
  config: TypedWebHandlerConfig<BaseServices, RequestServices, ApiDef>
): TypedWebHandler<RequestServices> => {
  // Build the full layer with placeholder request services
  // The placeholders will be overridden by the typed context parameter
  const fullLayer = Layer.mergeAll(
    HttpApiBuilder.api(config.api),
    config.apiLayer,
    config.baseLayer,
    HttpServer.layerContext
  )

  // Use HttpApiBuilder.toWebHandler internally
  const { handler: internalHandler, dispose } = HttpApiBuilder.toWebHandler(
    fullLayer as any // Type assertion needed due to internal types
  )

  // Wrap with properly typed signature
  const handler = (
    request: Request,
    context: Context.Context<RequestServices>
  ): Promise<Response> => {
    return internalHandler(request, context as Context.Context<never>)
  }

  return { handler, dispose }
}
```

### Usage

```typescript
// src/handler.ts
import { Layer, Context } from "effect"
import { makeTypedWebHandler } from "./lib/typed-web-handler"
import { WorkerApi } from "./definition"
import { HttpGroupsLive } from "./api"
import { AppLayer } from "./app"
import { CloudflareEnv, CloudflareCtx } from "./services"

/**
 * Type alias for request-scoped services
 */
export type RequestServices = CloudflareEnv | CloudflareCtx

/**
 * Create typed web handler
 */
export const { handler, dispose } = makeTypedWebHandler({
  api: WorkerApi,
  baseLayer: AppLayer,
  apiLayer: HttpGroupsLive,
})

// TypeScript now knows handler requires Context<CloudflareEnv | CloudflareCtx>
```

```typescript
// src/worker.ts
import { Context } from "effect"
import { handler, type RequestServices } from "./handler"
import { CloudflareEnv, CloudflareCtx } from "./services"

/**
 * Create request context - TypeScript validates all services provided
 */
const makeRequestContext = (
  env: Env,
  ctx: ExecutionContext
): Context.Context<RequestServices> =>
  Context.empty.pipe(
    Context.add(CloudflareEnv, { env }),
    Context.add(CloudflareCtx, { ctx })
  )

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const requestContext = makeRequestContext(env, ctx)

    // TypeScript ensures requestContext has all required services
    return handler(request, requestContext)
  }
}
```

## Why This Works

1. **Type Safety**: The handler signature explicitly requires `Context<RequestServices>`
2. **Compile-Time Validation**: Missing services cause TypeScript errors
3. **Runtime Correctness**: Context merging in `toWebHandlerRuntime` still works
4. **No Placeholders**: Base services don't include request-scoped ones

## The Remaining Issue: Layer Types

The challenge is that `HttpApiBuilder.group()` handlers using `yield* CloudflareEnv` make the layer **require** `CloudflareEnv`. This requirement propagates up to `toWebHandler`.

### Option A: Accept Internal Type Assertion

```typescript
// In makeTypedWebHandler
const { handler: internalHandler, dispose } = HttpApiBuilder.toWebHandler(
  fullLayer as any // Single type assertion, encapsulated
)
```

The type assertion is encapsulated inside our utility. External code is fully type-safe.

### Option B: Separate Handler Layers

Structure handlers to not depend on request-scoped services directly in the layer:

```typescript
// services/cloudflare.ts
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

// Handlers access CloudflareEnv - this creates the layer requirement
export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    handlers.handle("check", () =>
      Effect.gen(function* () {
        const { env } = yield* CloudflareEnv // ← Creates requirement
        return { status: "ok", environment: env.ENVIRONMENT }
      })
    )
)
```

The `CloudflareEnv` requirement comes from handlers using `yield* CloudflareEnv`. This is **unavoidable** if handlers need access to request-scoped data.

### Option C: FiberRef Alternative (No Layer Requirement)

Use FiberRef so handlers don't create layer requirements:

```typescript
// services/cloudflare.ts
import { FiberRef, Effect, Context } from "effect"

// FiberRef for request-scoped env (no layer requirement)
export const currentEnv = FiberRef.unsafeMake<Env | null>(null)

// Effect to get env (not a Context.Tag)
export const getEnv = Effect.flatMap(
  FiberRef.get(currentEnv),
  (env) => env === null
    ? Effect.die("CloudflareEnv not set")
    : Effect.succeed(env)
)

// Helper to set env for a request
export const withEnv = <A, E, R>(env: Env) =>
  (effect: Effect.Effect<A, E, R>) =>
    Effect.locally(currentEnv, env)(effect)
```

```typescript
// Handlers use getEnv instead of yield* CloudflareEnv
export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    handlers.handle("check", () =>
      Effect.gen(function* () {
        const env = yield* getEnv // ← No layer requirement!
        return { status: "ok", environment: env.ENVIRONMENT }
      })
    )
)
```

**Problem**: We can't use `withEnv` with `toWebHandler` because the handler is already a Promise function, not an Effect we can wrap.

## Final Recommendation

### For Maximum Type Safety: Custom Runtime Handler

Don't use `toWebHandler`. Build your own handler with explicit typing:

```typescript
// src/handler.ts
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect"
import {
  HttpApiBuilder,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { WorkerApi } from "./definition"
import { HttpGroupsLive } from "./api"
import { AppLayer } from "./app"
import { CloudflareEnv, CloudflareCtx } from "./services"

// Type for request-scoped services
export type RequestServices = CloudflareEnv | CloudflareCtx

// Base layer (everything except request-scoped)
const BaseLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi),
  HttpGroupsLive.pipe(Layer.provide(AppLayer)),
  HttpServer.layerContext
)

// Note: BaseLayer type still shows CloudflareEnv requirement
// because handlers use yield* CloudflareEnv

// Build runtime once
const runtime = ManagedRuntime.make(BaseLayer as Layer.Layer<any>)

// Get the HTTP app effect
const httpAppEffect = HttpApiBuilder.httpApp

/**
 * Type-safe request handler
 */
export const handler = async (
  request: Request,
  context: Context.Context<RequestServices>
): Promise<Response> => {
  const effect = Effect.gen(function* () {
    // Get HTTP app
    const app = yield* httpAppEffect

    // Create server request
    const serverRequest = HttpServerRequest.fromWeb(request)

    // Run app with request
    const response = yield* app.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped
    )

    return HttpServerResponse.toWeb(response)
  }).pipe(
    Effect.provide(context) // Provide typed request context
  )

  return runtime.runPromise(effect)
}

export const dispose = () => runtime.dispose()
```

### For Pragmatic Simplicity: Encapsulated Type Assertion

Use the wrapper with a single encapsulated type assertion:

```typescript
// src/lib/typed-web-handler.ts
export const makeTypedWebHandler = <RequestServices>() => {
  // ... implementation with internal type assertion
}

// Usage is fully type-safe
const { handler } = makeTypedWebHandler<CloudflareEnv | CloudflareCtx>()
```

## Summary

| Approach | Type-Safe | Simple | Works Now |
|----------|-----------|--------|-----------|
| Placeholder with assertion | ❌ | ✅ | ✅ |
| Typed wrapper (encapsulated assertion) | ✅* | ✅ | ✅ |
| Custom runtime handler | ✅ | ❌ | ⚠️ |
| FiberRef (no layer requirement) | ✅ | ❌ | ❌ |

*External code is type-safe; internal has one encapsulated assertion.

The **typed wrapper** approach gives the best balance: fully type-safe API for consumers while accepting one internal type assertion that's encapsulated and tested.
