# Effect Worker

An Effect-TS application running on Cloudflare Workers with request-scoped database connections using `HttpApiMiddleware`.

> **Note:** This project previously used a FiberRef-based approach for request-scoped dependencies. We've since migrated to `HttpApiMiddleware`, which provides a cleaner solution:
>
> - **Standard Effect patterns** – Use `yield* DatabaseService` instead of custom accessors
> - **Compile-time type safety** – Missing middleware causes type errors, not runtime failures
> - **Granular control** – Apply middleware at the API or group level (not all endpoints need a database)
>
> For the original FiberRef approach, see the [fiber-ref-poc branch](https://github.com/backpine/effect-worker/tree/fiber-ref-poc).

## The Problem

Cloudflare Workers can't share TCP connections between requests. Each request needs its own database connection that gets created, used, and cleaned up within that request's lifetime.

```
Traditional Node.js Server:
┌─────────────────────────────────────────────────────┐
│ Server Process                                      │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ Connection Pool (shared across requests)     │   │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐        │   │
│  │  │conn│ │conn│ │conn│ │conn│ │conn│        │   │
│  │  └────┘ └────┘ └────┘ └────┘ └────┘        │   │
│  └─────────────────────────────────────────────┘   │
│        ↑           ↑           ↑                   │
│   Request 1   Request 2   Request 3                │
└─────────────────────────────────────────────────────┘

Cloudflare Worker:
┌─────────────────────────────────────────────────────┐
│ Worker Isolate                                      │
│                                                     │
│  Request 1: [open conn] → [query] → [close conn]   │
│  Request 2: [open conn] → [query] → [close conn]   │
│  Request 3: [open conn] → [query] → [close conn]   │
│                                                     │
│  No shared state. No connection pool.              │
└─────────────────────────────────────────────────────┘
```

## Why Effect Layers Don't Work Here

In Effect, you typically define services with `Context.Tag` and compose them with `Layer`:

```typescript
// This is the "normal" Effect pattern
class Database extends Context.Tag("Database")<Database, DrizzleInstance>() {
  static Live = Layer.effect(this, makeDrizzleClient())
}

// Use in handlers
const getUsers = Effect.gen(function* () {
  const db = yield* Database
  return yield* db.select().from(users)
})
```

The problem: **Layers are memoized**.

When you create a `ManagedRuntime`, it builds all layers once at startup:

```typescript
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    Database.Live,        // Built ONCE at startup
    HttpRouter.Live,      // Built ONCE at startup
    HttpMiddleware.Live,  // Built ONCE at startup
  )
)
```

For Cloudflare Workers, `env` is available at startup, so we *could* create a database layer. But that layer would open a TCP connection once and try to reuse it across requests. **This fails immediately on the second request:**

```
ManagedRuntime with Database Layer:
┌─────────────────────────────────────────────────────┐
│ Module Initialization (once)                        │
│                                                     │
│   ManagedRuntime.make(layers)                       │
│        ↓                                            │
│   Build HttpRouter.Live ✓                           │
│   Build Database.Live ✓                             │
│        ↓                                            │
│   Opens TCP connection to Postgres                  │
│        ↓                                            │
│   Connection stored in layer (memoized)             │
│                                                     │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│ Request 1: Uses memoized connection ✓               │
│ Request 2: CRASH ✗                                  │
│ Request 3: Fresh isolate, works ✓                   │
│ Request 4: CRASH ✗                                  │
│ ...every other request fails                        │
└─────────────────────────────────────────────────────┘
```

The exact error from Cloudflare:

```
Error: Cannot perform I/O on behalf of a different request.
I/O objects (such as streams, request/response bodies, and others)
created in the context of one request handler cannot be accessed
from a different request's handler. This is a limitation of
Cloudflare Workers which allows us to improve overall performance.
```

This isn't about connections going stale - Cloudflare **actively prevents** I/O objects from being shared between requests. The TCP socket opened during Request 1 cannot be used by Request 2. Period.

## The Solution: HttpApiMiddleware

Effect's `HttpApiMiddleware` runs per-request, making it the perfect mechanism for request-scoped services. Unlike layers which are memoized at startup, middleware effects execute fresh for each request.

```
┌─────────────────────────────────────────────────────┐
│ ManagedRuntime (built once at startup)              │
│                                                     │
│   HttpApiBuilder.api(WorkerApi)  ← Router config    │
│   HttpApiBuilder.Router.Live     ← Router instance  │
│   CloudflareBindingsMiddlewareLive ← Middleware impl│
│   DatabaseMiddlewareLive           ← Middleware impl│
│                                                     │
│   Note: Middleware IMPLEMENTATIONS are memoized,    │
│   but the middleware EFFECTS run per-request!       │
└─────────────────────────────────────────────────────┘
                      ↓
              runtime.runPromise(effect)
                      ↓
┌─────────────────────────────────────────────────────┐
│ Per-Request (via HttpApiMiddleware)                 │
│                                                     │
│   CloudflareBindingsMiddleware → yield* effect      │
│     └─→ Provides { env, ctx } to handlers           │
│                                                     │
│   DatabaseMiddleware → yield* effect                │
│     └─→ Opens TCP connection                        │
│     └─→ Creates Drizzle instance                    │
│     └─→ Provides { drizzle } to handlers            │
│     └─→ Connection closed when request ends         │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## How It Works

### 1. Define Middleware with `provides`

Middleware uses `HttpApiMiddleware.Tag` with a `provides` option to inject services:

```typescript
// src/services/database.middleware.ts

// Service that middleware will provide
export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  { readonly drizzle: DrizzleInstance }
>() {}

// Error type with HTTP status annotation
export class DatabaseConnectionError extends S.TaggedError<DatabaseConnectionError>()(
  "DatabaseConnectionError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

// Middleware definition
export class DatabaseMiddleware extends HttpApiMiddleware.Tag<DatabaseMiddleware>()(
  "DatabaseMiddleware",
  {
    failure: DatabaseConnectionError,  // Possible errors
    provides: DatabaseService,          // Service to inject
  },
) {}
```

### 2. Implement Middleware

The middleware implementation returns an Effect that runs per-request:

```typescript
export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    // This outer Effect runs once (layer construction)
    // Return the inner Effect that runs per-request
    return Effect.gen(function* () {
      // Read env from FiberRef (set at entry point)
      const env = yield* FiberRef.get(currentEnv)
      if (env === null) {
        return yield* Effect.fail(
          new DatabaseConnectionError({ message: "Env not available" })
        )
      }

      // Create scoped connection (auto-closes when request ends)
      const pgClient = yield* PgClient.make({
        url: Redacted.make(env.DATABASE_URL),
      }).pipe(Effect.provide(Reactivity.layer))

      const drizzle = yield* PgDrizzle.make({
        casing: "snake_case",
      }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

      return { drizzle }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(new DatabaseConnectionError({
          message: `Connection failed: ${error}`
        }))
      )
    )
  }),
)
```

### 3. Apply Middleware to API/Groups

```typescript
// src/http/api.ts - Apply at API level
export class WorkerApi extends HttpApi.make("WorkerApi")
  .add(HealthGroup)
  .add(UsersGroup)
  .middleware(CloudflareBindingsMiddleware)  // Available everywhere
  .prefix("/api") {}

// src/http/groups/users.definition.ts - Apply at group level
export const UsersGroup = HttpApiGroup.make("users")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(UsersListSchema))
  .middleware(DatabaseMiddleware)  // Only for this group
  .prefix("/users")
```

### 4. Access Services in Handlers

Handlers use standard Effect service access - no special patterns needed:

```typescript
// src/http/groups/users.handlers.ts
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

          return { users: dbUsers, total: dbUsers.length }
        }),
      )
    }),
)
```

## Request Flow

```
fetch(request, env, ctx)
│
├─→ withCloudflareBindings(env, ctx)
│     └─→ Sets FiberRef (bridge to middleware)
│
└─→ runtime.runPromise(handleRequest(request))
      │
      ├─→ CloudflareBindingsMiddleware runs
      │     └─→ Reads FiberRef
      │     └─→ Provides { env, ctx } via Context
      │
      ├─→ DatabaseMiddleware runs
      │     └─→ Reads env.DATABASE_URL from FiberRef
      │     └─→ Opens TCP connection (scoped)
      │     └─→ Provides { drizzle } via Context
      │
      ├─→ Handler executes
      │     └─→ yield* DatabaseService → gets { drizzle }
      │     └─→ yield* CloudflareBindings → gets { env, ctx }
      │
      └─→ Response returned
            └─→ Request scope ends
            └─→ TCP connection automatically closed
```

## Type Safety

The middleware pattern provides compile-time guarantees:

```typescript
// If DatabaseMiddleware isn't applied to the group, this won't compile!
const { drizzle } = yield* DatabaseService
//                        ^^^^^^^^^^^^^^^
// Error: Service 'DatabaseService' is not available in the current context
```

## Entry Point

The entry point is minimal - just bridge Cloudflare bindings to Effect:

```typescript
// src/index.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = handleRequest(request).pipe(
      withCloudflareBindings(env, ctx),  // Bridge to Effect
    )
    return runtime.runPromise(effect)
  },
}
```

## Key Insight: Middleware Effects vs Layer Effects

The crucial difference is **when** the Effect runs:

| Aspect | Layer.effect | HttpApiMiddleware |
|--------|-------------|-------------------|
| **Runs when** | Once at layer construction | Per-request |
| **Resources** | Memoized, shared | Fresh each request |
| **Good for** | Static config, routers | Connections, auth |
| **Scoping** | Application lifetime | Request lifetime |

```typescript
// Layer: Effect runs ONCE at startup
const DbLayer = Layer.effect(Database, Effect.gen(function* () {
  const conn = yield* openConnection()  // Opens once, stays open
  return conn
}))

// Middleware: Effect runs PER-REQUEST
const DbMiddleware = Layer.effect(DatabaseMiddleware, Effect.gen(function* () {
  return Effect.gen(function* () {      // This inner effect runs per-request
    const conn = yield* openConnection()  // Opens fresh each request
    return { drizzle: conn }
  })
}))
```

## Why FiberRef is Still Needed

Middleware effects can only access `HttpRouter.Provided` context (request, route params, etc). They cannot depend on other services via `yield* OtherService`.

To pass Cloudflare's `env` and `ctx` from the entry point (outside Effect) into middleware (inside Effect), we use FiberRef as a bridge:

```typescript
// Entry point sets FiberRef
withCloudflareBindings(env, ctx)  // Sets currentEnv and currentCtx

// Middleware reads from FiberRef (no service dependency)
const env = yield* FiberRef.get(currentEnv)  // Works!

// This would NOT work in middleware:
const { env } = yield* CloudflareBindings  // Creates dependency, breaks middleware
```

## Development

```bash
# Start local Postgres
pnpm db:up

# Push schema
pnpm db:push

# Seed data
pnpm db:seed

# Run dev server
pnpm dev

# Type check
pnpm typecheck

# Run tests
pnpm test
```

## Project Structure

```
src/
├── index.ts                        # Worker entry point
├── runtime.ts                      # ManagedRuntime + middleware layers
├── services/
│   ├── index.ts                    # Re-exports
│   ├── cloudflare.middleware.ts    # CloudflareBindings middleware
│   └── database.middleware.ts      # Database middleware
├── http/
│   ├── api.ts                      # HttpApi definition + API-level middleware
│   ├── groups/
│   │   ├── *.definition.ts         # Endpoint schemas + group-level middleware
│   │   └── *.handlers.ts           # Handler implementations
│   ├── schemas/                    # Request/response schemas
│   └── errors/                     # API error types
└── db/
    └── schema.ts                   # Drizzle schema
```

## Testing

With middleware, testing uses standard Layer composition:

```typescript
// Mock the middleware
const MockDatabaseMiddlewareLive = Layer.succeed(
  DatabaseMiddleware,
  Effect.succeed({ drizzle: mockDrizzle }),
)

// Provide mock in tests
const TestLayer = HttpGroupsLive.pipe(
  Layer.provide(MockDatabaseMiddlewareLive),
)
```

## Comparison: Before and After

### Before (FiberRef Pattern)
```typescript
// Custom accessor functions
const db = yield* getDrizzle   // FiberRef.get + null check
const env = yield* getEnv      // FiberRef.get + null check

// Entry point wires everything
effect.pipe(
  withDatabase(env.DATABASE_URL),
  withEnv(env),
  withCtx(ctx),
)
```

### After (Middleware Pattern)
```typescript
// Standard Effect services
const { drizzle } = yield* DatabaseService      // Type-safe!
const { env, ctx } = yield* CloudflareBindings  // Type-safe!

// Entry point is minimal
effect.pipe(withCloudflareBindings(env, ctx))
```

| Aspect | FiberRef | Middleware |
|--------|----------|------------|
| **Type Safety** | Runtime null checks | Compile-time service requirements |
| **Error Handling** | Effect.die on null | Typed errors with HTTP status |
| **Standard Pattern** | Custom accessors | Standard `yield* Service` |
| **Testing** | Wrap with `withX()` | Provide mock Layer |
