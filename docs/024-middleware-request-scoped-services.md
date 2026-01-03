# Request-Scoped Services via HttpApiMiddleware

This document describes how to use Effect's `HttpApiMiddleware` to provide request-scoped services (like database connections) to handlers in Cloudflare Workers.

## The Problem

Cloudflare Workers require per-request database connections due to I/O isolation constraints. The current FiberRef approach works but bypasses Effect's standard Layer/Context pattern:

```typescript
// Current FiberRef pattern (works but non-standard)
const db = yield* getDrizzle  // FiberRef accessor
```

We want to use Effect's standard service pattern:

```typescript
// Standard Effect pattern (type-safe, composable)
const db = yield* PgDrizzle.PgDrizzle  // Context.Tag accessor
```

## The Solution: HttpApiMiddleware with `provides`

`HttpApiMiddleware.Tag` has a `provides` option that makes a service available to handlers. Since middleware runs per-request, it's the perfect mechanism for request-scoped services.

```
┌─────────────────────────────────────────────────────────────┐
│ Request Flow                                                 │
│                                                             │
│  fetch(request, env, ctx)                                   │
│       │                                                     │
│       ▼                                                     │
│  HttpApiMiddleware (per-request)                            │
│       │                                                     │
│       ├─→ DatabaseMiddleware                                │
│       │     └─→ Opens connection                            │
│       │     └─→ Provides PgDrizzle.PgDrizzle to handlers    │
│       │                                                     │
│       ├─→ CloudflareBindingsMiddleware                      │
│       │     └─→ Provides CloudflareBindings service         │
│       │                                                     │
│       ▼                                                     │
│  Handler                                                    │
│       │                                                     │
│       ├─→ yield* PgDrizzle.PgDrizzle  (from middleware)     │
│       ├─→ yield* CloudflareBindings   (from middleware)     │
│       │                                                     │
│       ▼                                                     │
│  Response returned, scoped resources cleaned up             │
└─────────────────────────────────────────────────────────────┘
```

## How HttpApiMiddleware Works

### 1. Middleware Definition

A middleware is defined using `HttpApiMiddleware.Tag<Self>()`:

```typescript
import { HttpApiMiddleware, HttpApiSchema } from "@effect/platform"
import { Context, Schema as S } from "effect"

// Error type for middleware failures
export class DatabaseConnectionError extends S.TaggedError<DatabaseConnectionError>()(
  "DatabaseConnectionError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

// Service tag that middleware will provide
export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  { readonly drizzle: PgRemoteDatabase<Record<string, never>> }
>() {}

// Middleware definition
export class DatabaseMiddleware extends HttpApiMiddleware.Tag<DatabaseMiddleware>()(
  "DatabaseMiddleware",
  {
    failure: DatabaseConnectionError,  // Possible errors
    provides: DatabaseService,          // Service to provide
  },
) {}
```

### 2. Middleware Implementation

The middleware implementation is a `Layer.effect` that returns an Effect providing the service:

```typescript
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import * as Reactivity from "@effect/experimental/Reactivity"
import * as SqlClient from "@effect/sql/SqlClient"

export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    // Middleware effect runs per-request
    return Effect.gen(function* () {
      // Access Cloudflare bindings (also provided by middleware)
      const { env } = yield* CloudflareBindings

      // Create scoped database connection
      const pgClient = yield* PgClient.make({
        url: Redacted.make(env.DATABASE_URL),
      }).pipe(Effect.provide(Reactivity.layer))

      const drizzle = yield* PgDrizzle.make({
        casing: "snake_case",
      }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

      // Return the service value
      return { drizzle }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new DatabaseConnectionError({
            message: `Failed to connect: ${error}`
          })
        )
      )
    )
  }),
)
```

### 3. Apply Middleware to Groups

Middleware is applied at the group or endpoint level using `.middleware()`:

```typescript
// users.definition.ts
export const UsersGroup = HttpApiGroup.make("users")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(UsersListSchema))
  .add(
    HttpApiEndpoint.get("get", "/:id")
      .setPath(UserIdPathSchema)
      .addSuccess(UserSchema)
      .addError(UserNotFoundError),
  )
  .middleware(DatabaseMiddleware)  // <- Apply middleware to all endpoints
  .prefix("/users")
```

### 4. Access Service in Handlers

Handlers can now access the provided service using standard `yield*`:

```typescript
// users.handlers.ts
export const UsersGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "users",
  (handlers) =>
    Effect.gen(function* () {
      return handlers.handle("list", () =>
        Effect.gen(function* () {
          // Access service provided by middleware (type-safe!)
          const { drizzle } = yield* DatabaseService

          const dbUsers = yield* drizzle
            .select()
            .from(users)
            .pipe(Effect.catchAll(() => Effect.succeed([])))

          return { users: dbUsers, total: dbUsers.length }
        }),
      )
    }),
)
```

## Type Safety

The middleware pattern provides compile-time type safety:

1. **If middleware isn't applied**: Handler won't compile - `DatabaseService` is missing from requirements

2. **If middleware is applied**: Handler gets the service automatically - no runtime checks needed

3. **Error propagation**: Middleware failures (like connection errors) are typed and automatically converted to HTTP responses

```typescript
// This won't compile if DatabaseMiddleware isn't applied to the group!
const { drizzle } = yield* DatabaseService
//                        ^^^^^^^^^^^^^^^^^
// Error: Service 'DatabaseService' is not available in the current context
```

## Important Implementation Notes

### Middleware Effect Requirements

Middleware effects can ONLY have `HttpRouter.Provided` as their context requirements. This means:

1. **Middleware cannot depend on other middleware services** via `yield* OtherService`
2. **Middleware CAN read from FiberRef** since FiberRef reads don't create service dependencies
3. **Both CloudflareBindings and Database middleware read from the same FiberRefs** set by `withCloudflareBindings()`

```typescript
// WRONG: Creates a dependency that middleware can't satisfy
export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const { env } = yield* CloudflareBindings  // ❌ Creates dependency
      // ...
    })
  }),
)

// CORRECT: Read directly from FiberRef
export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv)  // ✓ No dependency
      // ...
    })
  }),
)
```

### Middleware Layer Provision

Middleware layers must be provided at the **runtime level**, not just at the groups level:

```typescript
// runtime.ts
const MiddlewareLive = Layer.mergeAll(
  CloudflareBindingsMiddlewareLive,
  DatabaseMiddlewareLive,
)

const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi).pipe(Layer.provide(HttpGroupsLive)),
  HttpApiBuilder.Router.Live,
  HttpApiBuilder.Middleware.layer,
  HttpServer.layerContext,
).pipe(Layer.provide(MiddlewareLive))  // ← Provide middleware here
```

## Implementation for effect-worker

### File Structure

```
src/
├── services/
│   ├── index.ts                    # Re-exports
│   ├── cloudflare.middleware.ts    # CloudflareBindings middleware (definition + implementation)
│   └── database.middleware.ts      # Database middleware (definition + implementation)
├── http/
│   ├── api.ts                      # WorkerApi with API-level middleware
│   ├── groups/
│   │   ├── users.definition.ts     # Add .middleware(DatabaseMiddleware)
│   │   └── users.handlers.ts       # Use yield* DatabaseService
│   └── index.ts
├── runtime.ts                      # Provides middleware layers
└── index.ts                        # Worker entry point (simplified)
```

### Step 1: CloudflareBindings Middleware

The first middleware provides Cloudflare's `env` and `ctx` to downstream middleware and handlers.

```typescript
// src/services/cloudflare.middleware.ts
import { HttpApiMiddleware, HttpApiSchema } from "@effect/platform"
import { Context, Effect, Layer, Schema as S } from "effect"

// Service definition
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  { readonly env: Env; readonly ctx: ExecutionContext }
>() {}

// Error (shouldn't happen in practice)
export class CloudflareBindingsError extends S.TaggedError<CloudflareBindingsError>()(
  "CloudflareBindingsError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// Middleware definition
export class CloudflareBindingsMiddleware extends HttpApiMiddleware.Tag<CloudflareBindingsMiddleware>()(
  "CloudflareBindingsMiddleware",
  {
    failure: CloudflareBindingsError,
    provides: CloudflareBindings,
  },
) {}

// FiberRef to pass env/ctx from entry point to middleware
import { FiberRef } from "effect"

export const currentEnv = FiberRef.unsafeMake<Env | null>(null)
export const currentCtx = FiberRef.unsafeMake<ExecutionContext | null>(null)

// Middleware implementation
export const CloudflareBindingsMiddlewareLive = Layer.effect(
  CloudflareBindingsMiddleware,
  Effect.gen(function* () {
    // Return the middleware effect (runs per-request)
    return Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv)
      const ctx = yield* FiberRef.get(currentCtx)

      if (env === null || ctx === null) {
        return yield* Effect.fail(
          new CloudflareBindingsError({
            message: "Cloudflare bindings not available"
          })
        )
      }

      return { env, ctx }
    })
  }),
)

// Helper for entry point
export const withCloudflareBindings = (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.locally(currentEnv, env),
      Effect.locally(currentCtx, ctx),
    )
```

### Step 2: Database Middleware

```typescript
// src/services/database.middleware.ts
import { HttpApiMiddleware, HttpApiSchema } from "@effect/platform"
import { Context, Effect, Layer, Redacted, Schema as S } from "effect"
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import * as Reactivity from "@effect/experimental/Reactivity"
import * as SqlClient from "@effect/sql/SqlClient"
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy"
import { CloudflareBindings } from "./cloudflare.middleware"

// Type alias
type DrizzleInstance = PgRemoteDatabase<Record<string, never>>

// Service definition
export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  { readonly drizzle: DrizzleInstance }
>() {}

// Error type
export class DatabaseConnectionError extends S.TaggedError<DatabaseConnectionError>()(
  "DatabaseConnectionError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

// Middleware definition
export class DatabaseMiddleware extends HttpApiMiddleware.Tag<DatabaseMiddleware>()(
  "DatabaseMiddleware",
  {
    failure: DatabaseConnectionError,
    provides: DatabaseService,
  },
) {}

const LOCAL_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/effect_worker"

// Middleware implementation
export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    // Return the middleware effect
    return Effect.gen(function* () {
      // Get env from CloudflareBindings middleware
      const { env } = yield* CloudflareBindings
      const connectionString = env.DATABASE_URL ?? LOCAL_DATABASE_URL

      // Create scoped connection (cleaned up when request ends)
      const pgClient = yield* PgClient.make({
        url: Redacted.make(connectionString),
      }).pipe(Effect.provide(Reactivity.layer))

      const drizzle = yield* PgDrizzle.make({
        casing: "snake_case",
      }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

      return { drizzle }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new DatabaseConnectionError({
            message: `Database connection failed: ${error}`,
          })
        )
      )
    )
  }),
)
```

### Step 3: Apply Middleware to API/Groups

```typescript
// src/http/api.ts
import { HttpApi } from "@effect/platform"
import { HealthGroup, UsersGroup } from "./groups"
import { CloudflareBindingsMiddleware } from "@/services/cloudflare.middleware"

// Apply CloudflareBindings at API level (available to all handlers)
export class WorkerApi extends HttpApi.make("WorkerApi")
  .add(HealthGroup)
  .add(UsersGroup)
  .middleware(CloudflareBindingsMiddleware)
  .prefix("/api") {}
```

```typescript
// src/http/groups/users.definition.ts
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { DatabaseMiddleware } from "@/services/database.middleware"
// ... schemas ...

export const UsersGroup = HttpApiGroup.make("users")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(UsersListSchema))
  .add(
    HttpApiEndpoint.get("get", "/:id")
      .setPath(UserIdPathSchema)
      .addSuccess(UserSchema)
      .addError(UserNotFoundError),
  )
  .middleware(DatabaseMiddleware)  // <- Database available for this group
  .prefix("/users")
```

### Step 4: Update Handlers

```typescript
// src/http/groups/users.handlers.ts
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { WorkerApi } from "@/http/api"
import { DatabaseService } from "@/services/database.middleware"
import { users } from "@/db"

export const UsersGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "users",
  (handlers) =>
    Effect.gen(function* () {
      return handlers.handle("list", () =>
        Effect.gen(function* () {
          // Standard Effect pattern - type-safe!
          const { drizzle } = yield* DatabaseService

          const dbUsers = yield* drizzle
            .select()
            .from(users)
            .pipe(Effect.catchAll(() => Effect.succeed([])))

          return { users: dbUsers, total: dbUsers.length }
        }),
      )
    }),
)
```

### Step 5: Wire Middleware in Groups

```typescript
// src/http/groups/index.ts
import { Layer } from "effect"
import { HealthGroupLive } from "./health.handlers"
import { UsersGroupLive } from "./users.handlers"
import { CloudflareBindingsMiddlewareLive } from "@/services/cloudflare.middleware"
import { DatabaseMiddlewareLive } from "@/services/database.middleware"

// Compose middleware (order matters: CloudflareBindings before Database)
const MiddlewareLive = Layer.mergeAll(
  CloudflareBindingsMiddlewareLive,
  DatabaseMiddlewareLive,
)

export const HttpGroupsLive = Layer.mergeAll(
  HealthGroupLive,
  UsersGroupLive,
).pipe(Layer.provide(MiddlewareLive))
```

### Step 6: Simplify Entry Point

```typescript
// src/index.ts
import { Effect } from "effect"
import { runtime, handleRequest, openApiSpec } from "@/runtime"
import { withCloudflareBindings } from "@/services/cloudflare.middleware"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname === "/api/openapi.json") {
      return Response.json(openApiSpec)
    }

    // Only need to pass Cloudflare bindings via FiberRef
    // Database connection is handled by middleware
    const effect = handleRequest(request).pipe(
      withCloudflareBindings(env, ctx),
    )

    return runtime.runPromise(effect)
  },
}
```

## Comparison: FiberRef vs Middleware

| Aspect | FiberRef Pattern | Middleware Pattern |
|--------|------------------|-------------------|
| **Type Safety** | Runtime check (`if null, die`) | Compile-time (service in requirements) |
| **Standard Effect** | Non-standard | Standard Context.Tag pattern |
| **Composability** | Manual wiring | Layer composition |
| **Error Handling** | Dies on missing | Typed errors with HTTP status |
| **Service Location** | Accessor functions | `yield* ServiceTag` |
| **Testing** | Wrap with `withDatabase()` | Provide mock Layer |

## Handling Scoped Resources

The key insight is that middleware effects are scoped to the request. When middleware creates a scoped resource (like a database connection via `PgClient.make`), it's automatically cleaned up when the request ends.

```typescript
// This works because the middleware effect runs within the request scope
const pgClient = yield* PgClient.make({
  url: Redacted.make(connectionString),
}).pipe(Effect.provide(Reactivity.layer))
```

The `Effect.scoped` in `handleRequest` ensures resources are cleaned up:

```typescript
const response = yield* app.pipe(
  Effect.provideService(ServerRequest.HttpServerRequest, serverRequest),
  Effect.scoped,  // <- Scopes all resources, including middleware-created ones
)
```

## Alternative: Direct PgDrizzle.PgDrizzle Service

Instead of a custom `DatabaseService` wrapper, you could provide `PgDrizzle.PgDrizzle` directly:

```typescript
// Middleware provides PgDrizzle.PgDrizzle directly
export class DatabaseMiddleware extends HttpApiMiddleware.Tag<DatabaseMiddleware>()(
  "DatabaseMiddleware",
  {
    failure: DatabaseConnectionError,
    provides: PgDrizzle.PgDrizzle,  // <- Provide the actual service tag
  },
) {}

// Implementation returns the drizzle instance directly
export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      // ... create connection ...
      return drizzle  // Return drizzle directly (not wrapped)
    })
  }),
)

// Handler uses PgDrizzle.PgDrizzle directly
const drizzle = yield* PgDrizzle.PgDrizzle
```

This aligns perfectly with how `effect-api-example` uses `PgDrizzle.PgDrizzle` in handlers.

## Testing

With middleware, testing becomes standard Layer composition:

```typescript
// test/fixtures/mock-services.ts
import { Layer } from "effect"
import { DatabaseMiddleware, DatabaseService } from "@/services/database.middleware"

const mockDrizzle = {
  select: () => ({ from: () => Effect.succeed([]) }),
  // ... other methods
} as any

export const MockDatabaseMiddlewareLive = Layer.succeed(
  DatabaseMiddleware,
  Effect.succeed({ drizzle: mockDrizzle }),
)

export const MockCloudflareBindingsMiddlewareLive = Layer.succeed(
  CloudflareBindingsMiddleware,
  Effect.succeed({ env: mockEnv, ctx: mockCtx }),
)

// In tests
const TestHttpGroupsLive = HttpGroupsLive.pipe(
  Layer.provide(MockDatabaseMiddlewareLive),
  Layer.provide(MockCloudflareBindingsMiddlewareLive),
)
```

## Summary

The `HttpApiMiddleware` pattern provides:

1. **Standard Effect patterns**: Use `yield* ServiceTag` instead of custom accessors
2. **Compile-time type safety**: Missing middleware = compile error
3. **Request-scoped by design**: Middleware runs per-request
4. **Automatic resource cleanup**: Scoped resources cleaned up with request
5. **Composable layers**: Standard Layer.provide for testing and composition
6. **Typed errors**: Middleware failures become proper HTTP responses

The key insight is that `HttpApiMiddleware` with `provides` is the Effect-native way to do request-scoped dependency injection, which is exactly what Cloudflare Workers need for database connections.
