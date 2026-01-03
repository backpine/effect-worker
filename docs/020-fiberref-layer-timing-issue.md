# 020 - FiberRef + Layer Timing Issue

## The Error

```
(FiberFailure) Error: SqlClient not available. Ensure withDatabase() wraps the handler.
```

## Root Cause

**Layers are memoized and built ONCE, not per-request.**

When using `ManagedRuntime.make(ApiLayer)`:
1. The runtime is created with a `MemoMap` for layer caching
2. On first `runPromise` call, layers are built and cached
3. `SqlClientLive` runs its effect: `FiberRef.get(currentSqlClient)` → **null**
4. The layer building happens BEFORE `Effect.locally` sets the FiberRef value

### Execution Order Problem

```typescript
// worker.ts
const effect = handleRequest(request).pipe(withRequestScope(env, ctx))
return runtime.runPromise(effect)
```

What we expected:
1. `withDatabase()` sets FiberRef via `Effect.locally`
2. `handleRequest()` runs inside that scope
3. Layer accesses FiberRef → gets the value

What actually happens:
1. `runtime.runPromise()` starts
2. Runtime builds/retrieves layers from MemoMap
3. `SqlClientLive` effect runs → FiberRef is null (not set yet!)
4. Layer fails with "SqlClient not available"
5. `Effect.locally` never gets a chance to run

### Why This Happens

`ManagedRuntime` evaluates layers in a shared context, not in the fiber's local context. The `MemoMap` caches layer results across all `runPromise` calls.

Even if layers were built lazily inside the effect:
- First request: Layer builds with FiberRef value from that request
- Second request: Layer is cached, uses first request's value (wrong!)

## Solutions

### Solution 1: Don't Use Layers for Request-Scoped Services (Recommended)

Use `Effect.provideService` instead of layers for anything request-scoped:

```typescript
// handler.ts - NO database layer in the runtime
const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi).pipe(Layer.provide(HttpGroupsLive)),
  HttpApiBuilder.Router.Live,
  HttpApiBuilder.Middleware.layer,
  HttpServer.layerContext
)

export const runtime = ManagedRuntime.make(ApiLayer)
```

```typescript
// worker.ts - provide database per-request
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = Effect.scoped(
      Effect.gen(function* () {
        // Create database connection
        const pgClient = yield* PgClient.make({ url: Redacted.make(env.DATABASE_URL) })
          .pipe(Effect.provide(Reactivity.layer))

        // Create drizzle instance
        const drizzle = yield* PgDrizzle.make({ client: pgClient })

        // Run handler with database provided
        return yield* handleRequest(request).pipe(
          Effect.provideService(SqlClient.SqlClient, pgClient),
          Effect.provideService(PgDrizzle.PgDrizzle, drizzle),
          withEnv(env),
          withCtx(ctx)
        )
      })
    )

    return runtime.runPromise(effect)
  }
}
```

### Solution 2: Use toWebHandler with Placeholder Pattern

The original placeholder pattern works because `toWebHandler` merges the context parameter at request time:

```typescript
// handler.ts
const SqlClientPlaceholder = Layer.succeed(SqlClient.SqlClient, null as any)
const PgDrizzlePlaceholder = Layer.succeed(PgDrizzle.PgDrizzle, null as any)

const ApiLive = HttpApiBuilder.api(WorkerApi).pipe(
  Layer.provide(HttpGroupsLive),
  Layer.provide(SqlClientPlaceholder),
  Layer.provide(PgDrizzlePlaceholder)
)

export const { handler } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext)
)
```

```typescript
// worker.ts
const requestContext = Context.make(SqlClient.SqlClient, pgClient)
  .pipe(Context.add(PgDrizzle.PgDrizzle, drizzle))

return handler(request, requestContext)
```

### Solution 3: Fresh Runtime Per Request (Not Recommended)

Build a new runtime for each request:

```typescript
// worker.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const RequestLayer = Layer.mergeAll(
      PgClient.layer({ url: Redacted.make(env.DATABASE_URL) }),
      PgDrizzle.layer,
      // ... other layers
    )

    const runtime = ManagedRuntime.make(RequestLayer)
    try {
      return await runtime.runPromise(handleRequest(request))
    } finally {
      await runtime.dispose()
    }
  }
}
```

**Downsides:**
- Layer building overhead per request
- No benefit from layer memoization
- More complex lifecycle management

## Why FiberRef Doesn't Work Here

FiberRef is designed for fiber-local state within a single Effect execution. It works great for:
- Passing context down through Effect composition
- Request-scoped values within a single `runPromise` call

It does NOT work for:
- Layer construction (layers are built in a shared context)
- Values that need to be different per-request when layers are memoized

## Recommendation

**Use Solution 1** - provide database services via `Effect.provideService` per-request.

This is explicit, type-safe, and matches how Cloudflare Workers actually work (connections must be per-request).

The FiberRef pattern for CloudflareEnv/CloudflareCtx still works because handlers access them directly via `getEnv`/`getCtx` (not through layers).
