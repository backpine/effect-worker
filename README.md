# Effect Worker

An Effect-TS application running on Cloudflare Workers with request-scoped database connections.

> **Note**: This is an exploration of patterns for Effect + Cloudflare Workers. The FiberRef approach works, but there may be better patterns. Feedback welcome.

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

## Our Solution: FiberRef

FiberRef provides fiber-local storage. Think of it like `AsyncLocalStorage` in Node.js.

```typescript
// Create a FiberRef with null default
export const currentDrizzle = FiberRef.unsafeMake<DrizzleInstance | null>(null)

// Accessor - dies if null (programming error)
export const getDrizzle = Effect.gen(function* () {
  const drizzle = yield* FiberRef.get(currentDrizzle)
  if (drizzle === null) {
    return yield* Effect.die("Database not available")
  }
  return drizzle
})

// Wrapper - sets value for scope of effect
export const withDatabase = (connectionString: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const pgClient = yield* PgClient.make({ url: connectionString })
        const drizzle = yield* PgDrizzle.make()
        return yield* Effect.locally(currentDrizzle, drizzle)(effect)
      })
    )
```

## Request Flow

```
fetch(request, env, ctx)
│
├─→ withDatabase(env.DATABASE_URL)
│     └─→ Opens TCP connection
│         └─→ Sets FiberRef
│
├─→ withEnv(env)
│     └─→ Sets FiberRef
│
├─→ withCtx(ctx)
│     └─→ Sets FiberRef
│
└─→ handleRequest(request)
      │
      ├─→ Handler calls: yield* getDrizzle
      │     └─→ Reads from FiberRef
      │
      └─→ Response returned
            └─→ Scope ends, TCP connection closed
```

## Usage in Handlers

```typescript
// src/http/groups/users.handlers.ts
.handle("list", () =>
  Effect.gen(function* () {
    const db = yield* getDrizzle  // Gets request-scoped connection
    const dbUsers = yield* db.select().from(users)
    return { users: dbUsers, total: dbUsers.length }
  })
)
```

## Entry Point

```typescript
// src/index.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = handleRequest(request).pipe(
      withDatabase(env.DATABASE_URL ?? LOCAL_DATABASE_URL),
      withEnv(env),
      withCtx(ctx),
    )
    return runtime.runPromise(effect)
  }
}
```

## What Gets Memoized vs Per-Request

```
┌─────────────────────────────────────────────────────┐
│ ManagedRuntime (built once, reused)                 │
│                                                     │
│   HttpApiBuilder.api(WorkerApi)  ← Router config    │
│   HttpApiBuilder.Router.Live     ← Router instance  │
│   HttpApiBuilder.Middleware.layer                   │
│   HttpServer.layerContext                           │
│                                                     │
└─────────────────────────────────────────────────────┘
                      ↓
              runtime.runPromise(effect)
                      ↓
┌─────────────────────────────────────────────────────┐
│ Per-Request (via FiberRef)                          │
│                                                     │
│   withDatabase() → getDrizzle                       │
│   withEnv()      → getEnv                           │
│   withCtx()      → getCtx                           │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Open Questions

1. **Is FiberRef the right pattern?** It works, but feels like we're working around Effect's layer system rather than with it.

2. **Layer.scoped alternative?** Could we create a per-request runtime instead of a shared one? Probably too expensive (rebuilds all layers per request).

3. **Effect.locally gotchas?** Are there edge cases where the FiberRef value doesn't propagate correctly (forked fibers, etc)?

4. **Testing implications?** FiberRef requires wrapping test effects with `withDatabase()` etc. Is there a cleaner way?

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
├── index.ts           # Worker entry point, request scoping
├── runtime.ts         # ManagedRuntime setup
├── services/
│   ├── cloudflare.ts  # FiberRef for env/ctx
│   └── database.ts    # FiberRef for Drizzle
├── http/
│   ├── api.ts         # HttpApi definition
│   ├── groups/        # Endpoint definitions + handlers
│   ├── schemas/       # Request/response schemas
│   └── errors/        # API error types
└── db/
    └── schema.ts      # Drizzle schema
```
