# 021 - Alternatives to ManagedRuntime for Request-Scoped Services

## Problem Statement

The current architecture has a type mismatch:

```typescript
// handler.ts
const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi).pipe(Layer.provide(ApiImplementationLayer)),
  HttpApiBuilder.Router.Live,
  HttpApiBuilder.Middleware.layer,
  HttpServer.layerContext
)

export const runtime = ManagedRuntime.make(ApiLayer)
// ERROR: Layer<..., never, PgDrizzle> not assignable to Layer<..., never, never>
```

**Root cause**: Handlers inside `HttpApiBuilder.group()` use `yield* PgDrizzle.PgDrizzle`, which creates a type-level dependency. Even though `withDatabase()` provides this service at runtime via `Effect.provideService`, the **layer's type signature** still requires `PgDrizzle`.

## Constraint

The user explicitly does not want placeholder services. This eliminates solutions like:
```typescript
// NOT acceptable
const PgDrizzlePlaceholder = Layer.succeed(PgDrizzle.PgDrizzle, null as any)
```

## Option 1: Use Effect.provide with Layer at Request Time (No ManagedRuntime)

Instead of pre-building a ManagedRuntime, build layers per-request and use `Effect.runPromise` directly.

```typescript
// handler.ts
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import * as ServerRequest from "@effect/platform/HttpServerRequest"
import * as ServerResponse from "@effect/platform/HttpServerResponse"
import { Effect, Layer, Runtime } from "effect"
import { WorkerApi } from "./definition"
import { ApiImplementationLayer } from "./app"

const BaseApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi).pipe(Layer.provide(ApiImplementationLayer)),
  HttpApiBuilder.Router.Live,
  HttpApiBuilder.Middleware.layer,
  HttpServer.layerContext
)

const httpAppEffect = HttpApiBuilder.httpApp

export const handleRequest = (request: Request, dbLayer: Layer.Layer<...>) =>
  Effect.gen(function* () {
    const app = yield* httpAppEffect
    const serverRequest = ServerRequest.fromWeb(request)

    const response = yield* app.pipe(
      Effect.provideService(ServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped
    )

    return ServerResponse.toWeb(response)
  }).pipe(
    Effect.provide(BaseApiLayer),
    Effect.provide(dbLayer)
  )
```

```typescript
// worker.ts
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import { Effect, Layer, Redacted } from "effect"
import * as Reactivity from "@effect/experimental/Reactivity"
import { handleRequest } from "./handler"
import { withEnv, withCtx } from "./services"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Build database layer per-request
    const DatabaseLayer = PgClient.layer({
      url: Redacted.make(env.DATABASE_URL),
    }).pipe(
      Layer.provide(Reactivity.layer),
      Layer.provideMerge(PgDrizzle.layer({ casing: "snake_case" }))
    )

    const effect = handleRequest(request, DatabaseLayer).pipe(
      withEnv(env),
      withCtx(ctx)
    )

    return Effect.runPromise(effect)
  }
}
```

**Pros:**
- No ManagedRuntime needed
- Database layer is truly per-request
- Clean type signatures (no placeholders)

**Cons:**
- `Effect.provide(BaseApiLayer)` rebuilds layers every request
- No layer memoization benefits
- Router, Middleware layers are rebuilt unnecessarily

---

## Option 2: Split Static and Dynamic Layers

Create a ManagedRuntime for static layers, provide dynamic layers at request time.

```typescript
// handler.ts
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpApiBuilder, HttpServer } from "@effect/platform"

// Static layers that DON'T depend on request-scoped services
const StaticLayer = Layer.mergeAll(
  HttpApiBuilder.Router.Live,
  HttpApiBuilder.Middleware.layer,
  HttpServer.layerContext
)

export const staticRuntime = ManagedRuntime.make(StaticLayer)

// The API layer still needs PgDrizzle - provide it per-request
const ApiLayer = HttpApiBuilder.api(WorkerApi).pipe(
  Layer.provide(ApiImplementationLayer)
)

export const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    const app = yield* HttpApiBuilder.httpApp
    const serverRequest = ServerRequest.fromWeb(request)

    return yield* app.pipe(
      Effect.provideService(ServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped
    )
  }).pipe(
    Effect.provide(ApiLayer)
    // PgDrizzle is NOT provided here - caller must provide it
  )
```

```typescript
// worker.ts
const withRequestScope = (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      withDatabase(env.DATABASE_URL), // Provides PgDrizzle
      withEnv(env),
      withCtx(ctx)
    )

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = handleRequest(request).pipe(withRequestScope(env, ctx))
    return staticRuntime.runPromise(effect)
  }
}
```

**Issue**: This still won't work because `Effect.provide(ApiLayer)` inside `handleRequest` returns an effect with `PgDrizzle` requirement. The type flows through.

---

## Option 3: Don't Use HttpApiBuilder.group for Database-Dependent Handlers

Create handlers that explicitly take database as a parameter instead of yielding it from context.

```typescript
// src/api/groups/HealthGroupLive.ts
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { WorkerApi } from "../../definition"
import { getEnv } from "../../services/cloudflare"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"

// Instead of yield* PgDrizzle.PgDrizzle inside the handler,
// we access it from a FiberRef pattern like CloudflareEnv

export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    Effect.gen(function* () {
      return handlers.handle("check", () =>
        Effect.gen(function* () {
          const env = yield* getEnv
          // Database access via a function that uses Effect.serviceOption
          // or wraps the dependency in a way that doesn't leak to layer type

          return {
            status: "ok" as const,
            timestamp: new Date().toISOString(),
            environment: env.ENVIRONMENT || "development",
          }
        })
      )
    })
)
```

**Issue**: The current handlers use `yield* PgDrizzle.PgDrizzle` which inherently creates the type dependency. You'd need a FiberRef-based pattern for database access too.

---

## Option 4: FiberRef for Database (Like CloudflareEnv)

Extend the FiberRef pattern to database, so handlers don't have layer dependencies.

```typescript
// src/services/database.ts
import { Effect, FiberRef } from "effect"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"

// FiberRef to hold the drizzle instance
export const currentDrizzle = FiberRef.unsafeMake<PgDrizzle.PgDrizzle | null>(null)

// Accessor that reads from FiberRef (no layer dependency!)
export const getDrizzle = Effect.gen(function* () {
  const drizzle = yield* FiberRef.get(currentDrizzle)
  if (drizzle === null) {
    return yield* Effect.die("Database not available. Ensure withDatabase() wraps the handler.")
  }
  return drizzle
})

// Setter
export const withDatabase = (connectionString: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const pgClient = yield* PgClient.make({ url: Redacted.make(connectionString) })
          .pipe(Effect.provide(Reactivity.layer))

        const drizzle = yield* PgDrizzle.make({ casing: "snake_case" })
          .pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

        // Set FiberRef and run effect
        return yield* Effect.locally(currentDrizzle, drizzle)(effect)
      })
    )
```

```typescript
// src/api/groups/HealthGroupLive.ts
import { getDrizzle } from "../../services/database"

export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    Effect.gen(function* () {
      return handlers.handle("check", () =>
        Effect.gen(function* () {
          const env = yield* getEnv
          const drizzle = yield* getDrizzle  // No layer dependency!

          const data = yield* drizzle
            .select()
            .from(deJobEvents)
            .limit(10)

          return {
            status: "ok" as const,
            timestamp: new Date().toISOString(),
            environment: env.ENVIRONMENT || "development",
          }
        })
      )
    })
)
```

**Pros:**
- No layer dependencies in handlers
- ManagedRuntime works (ApiLayer has R = never)
- Consistent pattern with CloudflareEnv/Ctx
- True per-request database connections

**Cons:**
- Loses type-safety of Effect's service system
- Runtime error if withDatabase not called (same as CloudflareEnv)
- Slightly non-idiomatic Effect pattern

---

## Option 5: Use Effect.runtime and Provide Layers Dynamically

Get the current runtime and provide layers to specific effects.

```typescript
// handler.ts
const BaseApiLayer = Layer.mergeAll(
  HttpApiBuilder.Router.Live,
  HttpApiBuilder.Middleware.layer,
  HttpServer.layerContext
)

export const baseRuntime = ManagedRuntime.make(BaseApiLayer)

export const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    const app = yield* HttpApiBuilder.httpApp
    // ... handle request
  })
// Note: This effect requires ApiImplementationLayer + PgDrizzle
```

```typescript
// worker.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Build full layer with database for this request
    const DatabaseLayer = PgClient.layer({ url: Redacted.make(env.DATABASE_URL) })
      .pipe(Layer.provideMerge(PgDrizzle.layer({ casing: "snake_case" })))

    const ApiLayer = HttpApiBuilder.api(WorkerApi)
      .pipe(Layer.provide(ApiImplementationLayer))

    const effect = handleRequest(request).pipe(
      Effect.provide(ApiLayer),
      Effect.provide(DatabaseLayer),
      withEnv(env),
      withCtx(ctx)
    )

    return baseRuntime.runPromise(effect)
  }
}
```

**Issue**: `Effect.provide(ApiLayer)` still evaluates the layer per-request, losing memoization benefits for the API layer.

---

## Recommendation: Option 4 (FiberRef for Database)

Given the constraints:
1. No placeholder services
2. Per-request database connections
3. Want to use ManagedRuntime for layer memoization

**Option 4 (FiberRef for Database)** is the best fit because:

1. **Consistent with CloudflareEnv pattern**: Already using FiberRef for `getEnv`/`getCtx`
2. **No type leakage**: Handlers don't create layer dependencies
3. **ManagedRuntime works**: ApiLayer has no external requirements
4. **True request isolation**: Each request gets its own database connection
5. **Simple mental model**: "Request-scoped things use FiberRef, static things use Layer"

### Implementation Plan

1. Add `currentDrizzle` FiberRef to `src/services/database.ts`
2. Create `getDrizzle` accessor (like `getEnv`)
3. Update `withDatabase` to set FiberRef via `Effect.locally`
4. Update handlers to use `getDrizzle` instead of `yield* PgDrizzle.PgDrizzle`
5. Optionally export the PgDrizzle type for convenience

This matches the pattern established in doc 020 and provides a consistent approach for all request-scoped services.
