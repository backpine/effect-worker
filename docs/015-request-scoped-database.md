# 015 - Request-Scoped Database Service

## Problem

Cloudflare Workers provide database connections (Hyperdrive, D1, etc.) through `env` bindings, which are only available at request time. Our current `HttpApiBuilder.toWebHandler()` pattern builds layers once at module initialization, but database connections need the request's `env`.

**The challenge**: How do we provide a database service that:
1. Gets its connection string from `env.HYPERDRIVE` (request-scoped)
2. Works with the placeholder pattern we established
3. Maintains proper connection lifecycle

## Options

### Option 1: Placeholder Pattern (Same as CloudflareEnv)

Use the same placeholder → runtime override pattern.

```typescript
// handler.ts
const DatabasePlaceholder = Layer.succeed(
  Database,
  {} as DrizzleClient  // Placeholder, overridden at runtime
)

// worker.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const db = drizzle(env.HYPERDRIVE.connectionString)

    const requestContext = Context.empty.pipe(
      Context.add(CloudflareEnv, { env }),
      Context.add(CloudflareCtx, { ctx }),
      Context.add(Database, db)  // Provide real database
    )

    return handler(request, requestContext)
  }
}
```

**Pros**:
- Simple, consistent with existing pattern
- Database created fresh per request
- Works with Hyperdrive connection pooling

**Cons**:
- No connection cleanup/finalization
- Database created even for requests that don't need it
- No Effect-managed lifecycle

### Option 2: Lazy Database via CloudflareEnv

Create the database lazily inside handlers, accessing `env` through `CloudflareEnv`.

```typescript
// services/database.ts
export const getDatabase = Effect.gen(function* () {
  const { env } = yield* CloudflareEnv
  return drizzle(env.HYPERDRIVE.connectionString)
})

// In handlers
const db = yield* getDatabase
const users = await db.select().from(usersTable)
```

**Pros**:
- Only creates connection when needed
- Uses existing CloudflareEnv service
- No additional placeholder needed

**Cons**:
- Creates new Drizzle instance per call (unless memoized)
- No centralized Database service tag
- Harder to mock in tests

### Option 3: Request-Scoped Layer Factory

Build the database layer per-request in worker.ts, then provide it.

```typescript
// services/database.ts
export const makeDatabaseLayer = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const db = drizzle(connectionString)
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        // Cleanup if needed
      }))
      return db
    })
  )

// worker.ts - NOT possible with toWebHandler
// Would need custom runtime management
```

**Cons**:
- Doesn't work with `toWebHandler` (layer is pre-built)
- Would need to abandon the simplified pattern

### Option 4: Ref-Based Database (Recommended)

Use an Effect `Ref` to hold the database connection, set it at request time.

```typescript
// services/database.ts
export class DatabaseRef extends Context.Tag("DatabaseRef")<
  DatabaseRef,
  Ref.Ref<DrizzleClient | null>
>() {}

export const Database = Effect.gen(function* () {
  const ref = yield* DatabaseRef
  const db = yield* Ref.get(ref)
  if (db === null) {
    return yield* Effect.die("Database not initialized")
  }
  return db
})

// handler.ts
const DatabaseRefLayer = Layer.effect(
  DatabaseRef,
  Ref.make<DrizzleClient | null>(null)
)

// worker.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const db = drizzle(env.HYPERDRIVE.connectionString)

    const requestContext = Context.empty.pipe(
      Context.add(CloudflareEnv, { env }),
      Context.add(CloudflareCtx, { ctx })
    )

    // Set the database in the ref before handling
    const effect = Effect.gen(function* () {
      const ref = yield* DatabaseRef
      yield* Ref.set(ref, db)
    }).pipe(
      Effect.andThen(/* actual request handling */)
    )

    // This gets complicated...
  }
}
```

**Cons**:
- Complex, doesn't fit `toWebHandler` well
- Requires custom effect orchestration

## Recommended Approach: Option 1 (Placeholder Pattern)

For Cloudflare Workers with Hyperdrive, **Option 1 is the best fit** because:

1. **Hyperdrive handles connection pooling** - You don't need to manage connections yourself
2. **Connections are lightweight** - Hyperdrive's proxy makes connection creation fast
3. **Matches existing pattern** - Consistent with CloudflareEnv/CloudflareCtx
4. **Simple to implement** - Minimal changes required

## Implementation

### Step 1: Update Database Service

```typescript
// src/services/database.ts
import { Context, Effect } from "effect"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { DatabaseError } from "@/errors"

export type DrizzleClient = ReturnType<typeof drizzle>

export class Database extends Context.Tag("Database")<
  Database,
  DrizzleClient
>() {}

/**
 * Create a database client from a connection string.
 *
 * For Hyperdrive, pass env.HYPERDRIVE.connectionString
 * For direct connection, pass env.DATABASE_URL
 */
export const makeDatabase = (connectionString: string): DrizzleClient => {
  const client = postgres(connectionString, {
    prepare: false,  // Required for Hyperdrive
  })
  return drizzle(client)
}

/**
 * Query helper with error handling
 */
export const query = <T>(
  fn: (db: DrizzleClient) => Promise<T>
): Effect.Effect<T, DatabaseError, Database> =>
  Effect.gen(function* () {
    const db = yield* Database
    return yield* Effect.tryPromise({
      try: () => fn(db),
      catch: (error) =>
        new DatabaseError({
          message: "Database query failed",
          cause: error,
        }),
    })
  }).pipe(
    Effect.withSpan("database.query", {
      attributes: { "db.system": "postgresql" },
    })
  )
```

### Step 2: Add Database Placeholder

```typescript
// src/handler.ts
import { Layer } from "effect"
import { HttpApiBuilder, HttpServer, OpenApi } from "@effect/platform"
import { WorkerApi } from "./definition"
import { ApiImplementationLayer } from "./app"
import { CloudflareEnv, CloudflareCtx, Database } from "./services"
import type { DrizzleClient } from "./services/database"

/**
 * Placeholder layers for request-scoped services.
 */
const CloudflareEnvPlaceholder = Layer.succeed(
  CloudflareEnv,
  { env: {} as Env }
)

const CloudflareCtxPlaceholder = Layer.succeed(
  CloudflareCtx,
  { ctx: {} as ExecutionContext }
)

const DatabasePlaceholder = Layer.succeed(
  Database,
  {} as DrizzleClient
)

/**
 * API Layer with all placeholders
 */
const ApiLive = HttpApiBuilder.api(WorkerApi).pipe(
  Layer.provide(ApiImplementationLayer),
  Layer.provide(CloudflareEnvPlaceholder),
  Layer.provide(CloudflareCtxPlaceholder),
  Layer.provide(DatabasePlaceholder)
)

export const { handler, dispose } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext)
)

export const openApiSpec = OpenApi.fromApi(WorkerApi)
```

### Step 3: Provide Database at Request Time

```typescript
// src/worker.ts
import { Context } from "effect"
import { handler, openApiSpec } from "./handler"
import { CloudflareEnv, CloudflareCtx, Database, makeDatabase } from "./services"

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

    // Create database from Hyperdrive connection
    const db = makeDatabase(env.HYPERDRIVE.connectionString)

    // Provide all request-scoped services
    const requestContext = Context.empty.pipe(
      Context.add(CloudflareEnv, { env }),
      Context.add(CloudflareCtx, { ctx }),
      Context.add(Database, db)
    )

    return handler(request, requestContext)
  }
}
```

### Step 4: Use in Handlers

```typescript
// src/api/groups/UsersGroupLive.ts
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { WorkerApi } from "../../definition"
import { Database, query } from "../../services"
import { users } from "../../db/schema"

export const UsersGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "users",
  (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle("list", () =>
          query(async (db) => {
            const results = await db.select().from(users)
            return { users: results, total: results.length }
          })
        )
        .handle("get", ({ path: { id } }) =>
          Effect.gen(function* () {
            const db = yield* Database
            const result = await db
              .select()
              .from(users)
              .where(eq(users.id, id))
              .limit(1)

            if (result.length === 0) {
              return yield* Effect.fail(
                new UserNotFoundError({ id, message: `User not found: ${id}` })
              )
            }
            return result[0]
          })
        )
    })
)
```

## Wrangler Configuration

```toml
# wrangler.toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"
```

```typescript
// worker-configuration.d.ts (generated)
interface Env {
  HYPERDRIVE: Hyperdrive
  // ... other bindings
}
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Module Initialization                                            │
│                                                                  │
│   DatabasePlaceholder ──► {} as DrizzleClient                    │
│   CloudflareEnvPlaceholder ──► { env: {} }                       │
│   CloudflareCtxPlaceholder ──► { ctx: {} }                       │
│                                                                  │
│   All placeholders provided to ApiLive layer                     │
│   toWebHandler builds runtime ONCE                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Per Request                                                      │
│                                                                  │
│   1. Create database: makeDatabase(env.HYPERDRIVE.connectionString)
│                                                                  │
│   2. Build context:                                              │
│      Context.empty.pipe(                                         │
│        Context.add(CloudflareEnv, { env }),                      │
│        Context.add(CloudflareCtx, { ctx }),                      │
│        Context.add(Database, db)      ◄── Real database          │
│      )                                                           │
│                                                                  │
│   3. Call handler: handler(request, requestContext)              │
│                                                                  │
│   4. Context merging overrides placeholders                      │
│                                                                  │
│   5. Handlers access real Database service                       │
└─────────────────────────────────────────────────────────────────┘
```

## Testing

Mock the database in tests by providing a test context:

```typescript
// test/helpers.ts
import { Context } from "effect"
import { Database, CloudflareEnv, CloudflareCtx } from "../src/services"

export const createTestContext = (mockDb: DrizzleClient) =>
  Context.empty.pipe(
    Context.add(CloudflareEnv, { env: mockEnv }),
    Context.add(CloudflareCtx, { ctx: mockCtx }),
    Context.add(Database, mockDb)
  )

// In tests
const mockDb = createMockDrizzle()
const context = createTestContext(mockDb)
const response = await handler(request, context)
```

## Considerations

### Connection Pooling

With Hyperdrive, connection pooling is handled at the Cloudflare edge. You don't need to configure `max` connections in postgres-js - Hyperdrive manages this.

### Connection Lifecycle

Since we create a new Drizzle instance per request:
- No explicit cleanup needed (Hyperdrive connections are pooled)
- If using direct postgres connections, consider connection limits
- For long-running queries, use `ctx.waitUntil()` to extend worker lifetime

### Performance

Creating a Drizzle client per request is fast (~1ms). The actual connection to Postgres is pooled by Hyperdrive, so there's no TCP handshake per request.

### When NOT to Use This Pattern

If you need:
- **Connection reuse across requests** - Use module-level `cloudflare:workers` env
- **Complex transaction management** - Consider a different architecture
- **Connection finalizers** - Need custom runtime management

## Summary

The placeholder pattern extends naturally to database services:

| Service | Placeholder | Runtime Override |
|---------|-------------|------------------|
| CloudflareEnv | `{ env: {} }` | Real `env` from fetch |
| CloudflareCtx | `{ ctx: {} }` | Real `ctx` from fetch |
| Database | `{} as DrizzleClient` | `makeDatabase(env.HYPERDRIVE.connectionString)` |

All request-scoped services follow the same pattern: placeholder at build time, real value via context at request time.
