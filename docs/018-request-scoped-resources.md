# 018 - Request-Scoped Resources in Cloudflare Workers

## The Problem

In Cloudflare Workers, TCP connections (like database connections) must be:
1. **Opened per-request** - Bindings like Hyperdrive are only available in the request context
2. **Isolated per-request** - Request 2 cannot share a TCP connection with Request 1
3. **Closed when request ends** - Resources must be released after response is sent

This is fundamentally different from traditional servers where connections can be pooled across requests.

```
Traditional Server:
┌─────────────────────────────────────────────────┐
│ Connection Pool (shared across requests)        │
│  ┌────┐ ┌────┐ ┌────┐                          │
│  │conn│ │conn│ │conn│                          │
│  └────┘ └────┘ └────┘                          │
│     ▲      ▲      ▲                            │
│  Request1  Request2  Request3                   │
└─────────────────────────────────────────────────┘

Cloudflare Workers:
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  Request 1  │ │  Request 2  │ │  Request 3  │
│  ┌────────┐ │ │  ┌────────┐ │ │  ┌────────┐ │
│  │  conn  │ │ │  │  conn  │ │ │  │  conn  │ │
│  └────────┘ │ │  └────────┘ │ │  └────────┘ │
│  (isolated) │ │  (isolated) │ │  (isolated) │
└─────────────┘ └─────────────┘ └─────────────┘
```

---

## Option 1: FiberRef + Effect.locally

Use `FiberRef` for fiber-local storage and `Effect.locally` to set values per-request.

### Core Concept

```typescript
// FiberRef is like thread-local storage, but for Effect fibers
const myRef = FiberRef.unsafeMake<string>("default")

// Effect.locally sets the value for the duration of an effect
const program = Effect.locally(myRef, "request-specific-value")(
  Effect.gen(function* () {
    const value = yield* FiberRef.get(myRef)
    // value is "request-specific-value" here
  })
)
```

### Implementation for Database

```typescript
// src/services/database.ts
import { FiberRef, Effect, Scope } from "effect"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

// ============================================================================
// Types
// ============================================================================

export type DrizzleClient = ReturnType<typeof drizzle>

export interface DatabaseConnection {
  readonly client: DrizzleClient
  readonly sql: postgres.Sql
}

// ============================================================================
// FiberRef for request-scoped database
// ============================================================================

/**
 * FiberRef holding the current request's database connection.
 * null means no connection has been established for this fiber.
 */
export const currentDatabase = FiberRef.unsafeMake<DatabaseConnection | null>(null)

// ============================================================================
// Database Access
// ============================================================================

/**
 * Get the database client for the current request.
 * Fails if called outside of a request context.
 */
export const Database = Effect.gen(function* () {
  const conn = yield* FiberRef.get(currentDatabase)
  if (conn === null) {
    return yield* Effect.die(
      "Database not available. Ensure withDatabase() wraps the request handler."
    )
  }
  return conn.client
})

/**
 * Execute a database query with automatic error handling.
 */
export const query = <T>(
  fn: (db: DrizzleClient) => Promise<T>
): Effect.Effect<T, DatabaseError, never> =>
  Effect.gen(function* () {
    const db = yield* Database
    return yield* Effect.tryPromise({
      try: () => fn(db),
      catch: (error) => new DatabaseError({ message: "Query failed", cause: error })
    })
  })

// ============================================================================
// Request Lifecycle
// ============================================================================

/**
 * Create a scoped database connection.
 * Connection is opened when scope starts, closed when scope ends.
 */
const makeDatabaseConnection = (connectionString: string) =>
  Effect.acquireRelease(
    // Acquire: open connection
    Effect.sync(() => {
      const sql = postgres(connectionString, { prepare: false })
      const client = drizzle(sql)
      return { client, sql }
    }),
    // Release: close connection
    (conn) =>
      Effect.promise(() => conn.sql.end()).pipe(
        Effect.catchAll(() => Effect.void)
      )
  )

/**
 * Run an effect with a request-scoped database connection.
 * The connection is:
 * - Opened when the request starts
 * - Available via `Database` effect
 * - Closed when the request ends (success or failure)
 */
export const withDatabase = (connectionString: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Acquire database connection (scoped - auto-released)
        const conn = yield* makeDatabaseConnection(connectionString)

        // Run the effect with database available in FiberRef
        return yield* Effect.locally(currentDatabase, conn)(effect)
      })
    )
```

### Usage in Worker

```typescript
// src/worker.ts
import { Effect, FiberRef } from "effect"
import { withDatabase, currentDatabase } from "./services/database"
import { CloudflareEnv, CloudflareCtx, currentEnv, currentCtx } from "./services/cloudflare"

// FiberRefs for request-scoped Cloudflare bindings
export const currentEnv = FiberRef.unsafeMake<Env | null>(null)
export const currentCtx = FiberRef.unsafeMake<ExecutionContext | null>(null)

/**
 * Wrap an effect with all request-scoped resources
 */
const withRequestContext = (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      // Provide database (scoped - opens and closes per request)
      withDatabase(env.HYPERDRIVE.connectionString),
      // Provide Cloudflare bindings
      Effect.locally(currentEnv, env),
      Effect.locally(currentCtx, ctx)
    )

// ManagedRuntime for global services (built once)
const runtime = ManagedRuntime.make(GlobalServicesLayer)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = handleRequest(request).pipe(
      withRequestContext(env, ctx)
    )

    return runtime.runPromise(effect)
  }
}
```

### Usage in Handlers

```typescript
// src/api/groups/UsersGroupLive.ts
import { Effect } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { Database, query } from "../../services/database"
import { users } from "../../db/schema"

export const UsersGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "users",
  (handlers) =>
    handlers
      .handle("list", () =>
        // Option 1: Use query helper
        query(async (db) => {
          const results = await db.select().from(users)
          return { users: results, total: results.length }
        })
      )
      .handle("get", ({ path: { id } }) =>
        // Option 2: Access Database directly
        Effect.gen(function* () {
          const db = yield* Database
          const result = await db.select().from(users).where(eq(users.id, id))
          if (result.length === 0) {
            return yield* Effect.fail(new UserNotFoundError({ id }))
          }
          return result[0]
        })
      )
)
```

### Pros & Cons

**Pros:**
- ✅ Fully type-safe - no placeholders or type assertions
- ✅ Idiomatic Effect pattern
- ✅ Clear resource lifecycle (acquire/release)
- ✅ Connection isolation guaranteed per-request
- ✅ Works with ManagedRuntime for global services

**Cons:**
- ❌ Doesn't integrate with `HttpApiBuilder.toWebHandler`
- ❌ Need custom handler instead of using platform convenience
- ❌ More code to set up

---

## Option 2: Effect.acquireUseRelease Per Request

Use `Effect.acquireUseRelease` for a simpler acquire-use-release pattern.

### Implementation

```typescript
// src/services/database.ts
import { Effect } from "effect"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export type DrizzleClient = ReturnType<typeof drizzle>

/**
 * Run an effect with a database connection.
 * Connection lifecycle is fully managed:
 * - Acquire: Open connection
 * - Use: Run your effect with the connection
 * - Release: Close connection (always runs, even on error)
 */
export const withDatabaseConnection = <A, E, R>(
  connectionString: string,
  use: (db: DrizzleClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | DatabaseError, R> =>
  Effect.acquireUseRelease(
    // Acquire
    Effect.sync(() => {
      const sql = postgres(connectionString, { prepare: false })
      return { sql, db: drizzle(sql) }
    }),
    // Use
    ({ db }) => use(db),
    // Release
    ({ sql }) =>
      Effect.promise(() => sql.end()).pipe(
        Effect.catchAll(() => Effect.void)
      )
  )
```

### Usage

```typescript
// src/worker.ts
import { Effect } from "effect"
import { withDatabaseConnection } from "./services/database"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = withDatabaseConnection(
      env.HYPERDRIVE.connectionString,
      (db) => handleRequest(request, db, env, ctx)
    )

    return Effect.runPromise(effect)
  }
}

// Handler receives db as parameter
const handleRequest = (
  request: Request,
  db: DrizzleClient,
  env: Env,
  ctx: ExecutionContext
) =>
  Effect.gen(function* () {
    // Use db directly
    const users = await db.select().from(usersTable)
    return new Response(JSON.stringify(users))
  })
```

### Pros & Cons

**Pros:**
- ✅ Simple and explicit
- ✅ Clear resource lifecycle
- ✅ No global state or FiberRef

**Cons:**
- ❌ Database must be passed through all functions (prop drilling)
- ❌ Doesn't work well with HttpApiBuilder patterns
- ❌ Less composable

---

## Option 3: Layer.scoped Per Request

Build a scoped Layer per-request that provides the database.

### Implementation

```typescript
// src/services/database.ts
import { Context, Effect, Layer, Scope } from "effect"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export type DrizzleClient = ReturnType<typeof drizzle>

export class Database extends Context.Tag("Database")<Database, DrizzleClient>() {}

/**
 * Create a scoped database layer for a specific connection string.
 * The connection is opened when the layer is built and closed when disposed.
 */
export const makeDatabaseLayer = (connectionString: string): Layer.Layer<Database> =>
  Layer.scoped(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => {
        const sql = postgres(connectionString, { prepare: false })
        return { sql, db: drizzle(sql) }
      }),
      ({ sql }) =>
        Effect.promise(() => sql.end()).pipe(
          Effect.catchAll(() => Effect.void)
        )
    ).pipe(Effect.map(({ db }) => db))
  )
```

### Usage with Per-Request Runtime

```typescript
// src/worker.ts
import { Effect, Layer, ManagedRuntime, Scope } from "effect"
import { Database, makeDatabaseLayer } from "./services/database"

// Global services layer (built once)
const GlobalLayer = Layer.mergeAll(ConfigLive, LoggerLive)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Create request-specific database layer
    const dbLayer = makeDatabaseLayer(env.HYPERDRIVE.connectionString)

    // Create request-specific cloudflare layer
    const cloudflareLayer = Layer.mergeAll(
      Layer.succeed(CloudflareEnv, { env }),
      Layer.succeed(CloudflareCtx, { ctx })
    )

    // Combine all layers for this request
    const requestLayer = Layer.mergeAll(dbLayer, cloudflareLayer).pipe(
      Layer.provideMerge(GlobalLayer)
    )

    // Build runtime for this request
    const runtime = ManagedRuntime.make(requestLayer)

    try {
      return await runtime.runPromise(handleRequest(request))
    } finally {
      // Dispose runtime - closes database connection
      await runtime.dispose()
    }
  }
}
```

### Pros & Cons

**Pros:**
- ✅ Uses standard Context.Tag pattern
- ✅ Handlers use normal `yield* Database`
- ✅ Clear resource lifecycle via Layer.scoped

**Cons:**
- ❌ **Expensive** - Layer building per request has overhead
- ❌ No memoization benefits across requests
- ❌ More complex runtime management

---

## Option 4: Hybrid - Global Runtime + Request Effect

Combine a global ManagedRuntime with request-scoped Effects.

### Implementation

```typescript
// src/services/database.ts
import { Context, Effect, Layer, Scope, FiberRef } from "effect"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export type DrizzleClient = ReturnType<typeof drizzle>

// Tag for dependency injection in handlers
export class Database extends Context.Tag("Database")<Database, DrizzleClient>() {}

// FiberRef for the actual connection (set per-request)
const currentDatabaseConnection = FiberRef.unsafeMake<DrizzleClient | null>(null)

/**
 * Layer that reads database from FiberRef.
 * This allows handlers to use `yield* Database` normally,
 * while the actual connection is set per-request via FiberRef.
 */
export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const db = yield* FiberRef.get(currentDatabaseConnection)
    if (db === null) {
      return yield* Effect.die("Database not initialized for this request")
    }
    return db
  })
)

/**
 * Create a scoped database connection and set it in FiberRef.
 */
export const withDatabase = (connectionString: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Acquire connection
        const sql = postgres(connectionString, { prepare: false })
        const db = drizzle(sql)

        // Register release
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => sql.end()).pipe(
            Effect.catchAll(() => Effect.void)
          )
        )

        // Run effect with database in FiberRef
        return yield* Effect.locally(currentDatabaseConnection, db)(effect)
      })
    )
```

### Full Worker Setup

```typescript
// src/services/cloudflare.ts
import { Context, FiberRef, Effect, Layer } from "effect"

// Tags
export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

export class CloudflareCtx extends Context.Tag("CloudflareCtx")<
  CloudflareCtx,
  { readonly ctx: ExecutionContext }
>() {}

// FiberRefs
export const currentEnv = FiberRef.unsafeMake<Env | null>(null)
export const currentCtx = FiberRef.unsafeMake<ExecutionContext | null>(null)

// Layers that read from FiberRef
export const CloudflareEnvLive = Layer.effect(
  CloudflareEnv,
  Effect.gen(function* () {
    const env = yield* FiberRef.get(currentEnv)
    if (env === null) {
      return yield* Effect.die("CloudflareEnv not set")
    }
    return { env }
  })
)

export const CloudflareCtxLive = Layer.effect(
  CloudflareCtx,
  Effect.gen(function* () {
    const ctx = yield* FiberRef.get(currentCtx)
    if (ctx === null) {
      return yield* Effect.die("CloudflareCtx not set")
    }
    return { ctx }
  })
)

// Helper to set request context
export const withCloudflare = (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.locally(currentEnv, env),
      Effect.locally(currentCtx, ctx)
    )
```

```typescript
// src/handler.ts
import { Layer } from "effect"
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { WorkerApi } from "./definition"
import { HttpGroupsLive } from "./api"
import { DatabaseLive, CloudflareEnvLive, CloudflareCtxLive } from "./services"

/**
 * API layer - uses Layers that read from FiberRef.
 * This compiles without request-scoped placeholders because
 * the Layers themselves are defined (they just read from FiberRef at runtime).
 */
const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi),
  HttpGroupsLive,
  DatabaseLive,
  CloudflareEnvLive,
  CloudflareCtxLive,
  HttpServer.layerContext
)

// Build runtime ONCE at module level
export const runtime = ManagedRuntime.make(ApiLayer)

// Get the HTTP app effect
export const httpAppEffect = HttpApiBuilder.httpApp
```

```typescript
// src/worker.ts
import { Effect } from "effect"
import * as ServerRequest from "@effect/platform/HttpServerRequest"
import * as ServerResponse from "@effect/platform/HttpServerResponse"
import { runtime, httpAppEffect } from "./handler"
import { withDatabase } from "./services/database"
import { withCloudflare } from "./services/cloudflare"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const effect = Effect.gen(function* () {
      // Get the HTTP app
      const app = yield* httpAppEffect

      // Create server request
      const serverRequest = ServerRequest.fromWeb(request)

      // Run the app
      const response = yield* app.pipe(
        Effect.provideService(ServerRequest.HttpServerRequest, serverRequest),
        Effect.scoped
      )

      return ServerResponse.toWeb(response)
    }).pipe(
      // Wrap with request-scoped resources
      withDatabase(env.HYPERDRIVE.connectionString),
      withCloudflare(env, ctx)
    )

    return runtime.runPromise(effect)
  }
}
```

### How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│ Module Initialization (ONCE)                                         │
│                                                                      │
│   DatabaseLive ──► Layer.effect that reads from FiberRef            │
│   CloudflareEnvLive ──► Layer.effect that reads from FiberRef       │
│                                                                      │
│   runtime = ManagedRuntime.make(ApiLayer)  ← Built once!            │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Request 1                                                            │
│                                                                      │
│   1. withDatabase(connString) ──► Opens connection                  │
│   2. Effect.locally(currentDatabaseConnection, db) ──► Sets FiberRef│
│   3. Handler: yield* Database ──► Layer reads FiberRef ──► Gets db  │
│   4. Response sent                                                   │
│   5. Scope closes ──► Connection released                           │
│                                                                      │
│   FiberRef values are ISOLATED to this fiber                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Request 2 (concurrent)                                               │
│                                                                      │
│   1. withDatabase(connString) ──► Opens DIFFERENT connection        │
│   2. Effect.locally(currentDatabaseConnection, db2) ──► Sets FiberRef
│   3. Handler: yield* Database ──► Gets db2 (NOT db1!)               │
│   4. Response sent                                                   │
│   5. Scope closes ──► Connection released                           │
│                                                                      │
│   Request 2's FiberRef is COMPLETELY ISOLATED from Request 1        │
└─────────────────────────────────────────────────────────────────────┘
```

### Pros & Cons

**Pros:**
- ✅ Type-safe - no placeholders or assertions
- ✅ Handlers use standard `yield* Database` pattern
- ✅ Runtime built once (efficient)
- ✅ Request isolation via FiberRef
- ✅ Scoped resource management (auto-cleanup)

**Cons:**
- ❌ More complex setup
- ❌ Layers are "dynamic" (read from FiberRef at runtime)
- ❌ Need to understand FiberRef semantics

---

## Option 5: Simple Per-Request Runtime (Recommended for Simplicity)

If you don't need maximum performance, this is the simplest approach.

### Implementation

```typescript
// src/services/database.ts
import { Context, Effect, Layer } from "effect"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export type DrizzleClient = ReturnType<typeof drizzle>

export class Database extends Context.Tag("Database")<Database, DrizzleClient>() {}

/**
 * Create database layer for a connection string.
 */
export const makeDatabaseLayer = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => {
        const sql = postgres(connectionString, { prepare: false })
        return { sql, db: drizzle(sql) }
      }),
      ({ sql }) => Effect.promise(() => sql.end()).pipe(Effect.catchAll(() => Effect.void))
    ).pipe(Effect.map(({ db }) => db))
  )
```

```typescript
// src/services/cloudflare.ts
import { Context, Layer } from "effect"

export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

export class CloudflareCtx extends Context.Tag("CloudflareCtx")<
  CloudflareCtx,
  { readonly ctx: ExecutionContext }
>() {}

export const makeCloudflareLayer = (env: Env, ctx: ExecutionContext) =>
  Layer.mergeAll(
    Layer.succeed(CloudflareEnv, { env }),
    Layer.succeed(CloudflareCtx, { ctx })
  )
```

```typescript
// src/handler.ts
import { Layer } from "effect"
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { WorkerApi } from "./definition"
import { HttpGroupsLive } from "./api"

// Global services (no request-scoped deps)
export const GlobalLayer = Layer.mergeAll(
  ConfigLive,
  LoggerLive,
  HttpServer.layerContext
)

// API without request-scoped services provided
export const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi),
  HttpGroupsLive
)
```

```typescript
// src/worker.ts
import { Layer, ManagedRuntime, Effect } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { ApiLayer, GlobalLayer } from "./handler"
import { makeDatabaseLayer } from "./services/database"
import { makeCloudflareLayer } from "./services/cloudflare"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Build complete layer for this request
    const requestLayer = Layer.mergeAll(
      ApiLayer,
      makeDatabaseLayer(env.HYPERDRIVE.connectionString),
      makeCloudflareLayer(env, ctx)
    ).pipe(
      Layer.provide(GlobalLayer)
    )

    // Create runtime for this request
    const runtime = ManagedRuntime.make(requestLayer)

    try {
      // Use HttpApiBuilder.toWebHandler pattern
      const { handler, dispose } = HttpApiBuilder.toWebHandler(requestLayer)
      const response = await handler(request)
      await dispose()
      return response
    } finally {
      await runtime.dispose()
    }
  }
}
```

### Pros & Cons

**Pros:**
- ✅ Simple - standard Effect patterns
- ✅ Type-safe - proper Layer types
- ✅ Clear resource lifecycle
- ✅ Uses toWebHandler

**Cons:**
- ❌ **Performance** - Layer built per request
- ❌ No memoization across requests
- ❌ More memory churn

---

## Comparison

| Option | Type-Safe | Performance | Complexity | toWebHandler |
|--------|-----------|-------------|------------|--------------|
| 1. FiberRef + locally | ✅ | ✅ | Medium | ❌ |
| 2. acquireUseRelease | ✅ | ✅ | Low | ❌ |
| 3. Layer.scoped/request | ✅ | ❌ | Medium | ✅ |
| 4. Hybrid FiberRef+Layer | ✅ | ✅ | High | ⚠️ |
| 5. Simple per-request | ✅ | ❌ | Low | ✅ |

---

## Recommendation

### For Maximum Performance: Option 4 (Hybrid)

- Runtime built once at module level
- FiberRef for request-scoped data
- Layers read from FiberRef
- Best of both worlds

### For Maximum Simplicity: Option 5 (Per-Request Runtime)

- Simple to understand
- Standard patterns
- Accept the performance trade-off
- Good for low-traffic workers

### For Database-Heavy Workloads: Option 1 (FiberRef + locally)

- Clean resource management
- Explicit lifecycle
- Skip toWebHandler, build custom handler

---

## Code Example: Option 4 Complete Implementation

See the full implementation in `src/` after running the migration.
