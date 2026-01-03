# 019 - Hybrid FiberRef Implementation Plan

## Overview

This plan follows the pattern from `effect-api-example` using `@effect/sql-drizzle/Pg`, adapted for Cloudflare Workers where database connections must be per-request.

## Reference: effect-api-example Pattern

```typescript
// SqlLive.ts
import * as PgDrizzle from '@effect/sql-drizzle/Pg'
import { PgClient } from '@effect/sql-pg'

const PgLive = Layer.scopedContext(
  Effect.gen(function* () {
    const client = yield* PgClient.make({
      host, port, database, password, username
    })
    return Context.make(PgClient.PgClient, client)
      .pipe(Context.add(Client.SqlClient, client))
  })
)

const DrizzleLive = PgDrizzle.layerWithConfig({ casing: 'snake_case' })
  .pipe(Layer.provide(PgLive))

// Handler usage - queries are Effects!
const drizzle = yield* PgDrizzle.PgDrizzle
const results = yield* drizzle.select().from(employees)
```

**Key insight**: With `@effect/sql-drizzle`, queries return Effects. No need for `tryPromise` wrappers.

---

## The Challenge for Cloudflare Workers

In effect-api-example, the database layer is built once at startup. In Cloudflare Workers:

1. Connection string comes from `env.HYPERDRIVE` (only available at request time)
2. TCP connections must be opened/closed per-request
3. Requests must be isolated (no shared connections)

**Solution**: Use FiberRef to hold the `PgDrizzle` instance, set it per-request.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Module Initialization (ONCE)                                     │
│                                                                  │
│   PgDrizzleLive (reads from FiberRef)                           │
│   CloudflareEnvLive (reads from FiberRef)                       │
│                    │                                             │
│                    ▼                                             │
│            ManagedRuntime (built once)                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Per Request                                                      │
│                                                                  │
│   1. withRequestScope(env, ctx)                                 │
│      ├── Create PgClient from env.HYPERDRIVE                    │
│      ├── Create PgDrizzle instance                              │
│      ├── Effect.locally(currentDrizzle, drizzle)                │
│      └── Effect.locally(currentEnv, env)                        │
│                                                                  │
│   2. Handler: yield* PgDrizzle.PgDrizzle                        │
│      └── Layer reads from FiberRef → returns drizzle            │
│                                                                  │
│   3. Query: yield* drizzle.select().from(users)                 │
│      └── Returns Effect, not Promise!                           │
│                                                                  │
│   4. Scope closes → PgClient disposed                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@effect/sql": "^0.49.0",
    "@effect/sql-drizzle": "^0.48.0",
    "@effect/sql-pg": "^0.50.0"
  }
}
```

---

## File Structure

```
src/
├── services/
│   ├── index.ts           # Exports
│   ├── cloudflare.ts      # CloudflareEnv (FiberRef-based)
│   └── database.ts        # PgDrizzle (FiberRef-based)
├── db/
│   └── schema.ts          # Drizzle schema
├── api/
│   └── groups/
│       └── UsersGroupLive.ts
├── app.ts
├── handler.ts
└── worker.ts
```

---

## Implementation

### 1. `src/services/database.ts`

```typescript
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, FiberRef, Layer, Scope } from "effect"

// ============================================================================
// FiberRef for request-scoped database
// ============================================================================

/**
 * FiberRef holding the current request's PgDrizzle instance.
 */
export const currentDrizzle = FiberRef.unsafeMake<PgDrizzle.PgDrizzle | null>(null)

// ============================================================================
// Layer that reads from FiberRef
// ============================================================================

/**
 * PgDrizzle layer that reads from FiberRef.
 * The actual instance is set per-request via withDatabase().
 */
export const PgDrizzleLive = Layer.effect(
  PgDrizzle.PgDrizzle,
  Effect.gen(function* () {
    const drizzle = yield* FiberRef.get(currentDrizzle)
    if (drizzle === null) {
      return yield* Effect.die(
        "PgDrizzle not available. Ensure withDatabase() wraps the handler."
      )
    }
    return drizzle
  })
)

// ============================================================================
// Request-scoped database connection
// ============================================================================

/**
 * Create a scoped database connection for a request.
 *
 * - Opens PgClient with the connection string
 * - Creates PgDrizzle instance
 * - Sets FiberRef for handler access
 * - Closes connection when scope ends
 */
export const withDatabase = (connectionString: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Create PgClient (scoped - auto-closes)
        const client = yield* PgClient.make({
          url: connectionString,
        })

        // Create Drizzle instance
        const drizzle = yield* PgDrizzle.make({
          client,
          casing: "snake_case",
        })

        // Run effect with drizzle in FiberRef
        return yield* Effect.locally(currentDrizzle, drizzle)(effect)
      })
    )

// Re-export for handler usage
export { PgDrizzle }
```

### 2. `src/services/cloudflare.ts`

```typescript
import { Context, Effect, FiberRef, Layer } from "effect"

// ============================================================================
// FiberRefs
// ============================================================================

export const currentEnv = FiberRef.unsafeMake<Env | null>(null)
export const currentCtx = FiberRef.unsafeMake<ExecutionContext | null>(null)

// ============================================================================
// Service Tags
// ============================================================================

export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  { readonly env: Env }
>() {}

export class CloudflareCtx extends Context.Tag("CloudflareCtx")<
  CloudflareCtx,
  { readonly ctx: ExecutionContext }
>() {}

// ============================================================================
// Layers that read from FiberRef
// ============================================================================

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

// ============================================================================
// Helpers
// ============================================================================

export const withEnv = (env: Env) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.locally(currentEnv, env)(effect)

export const withCtx = (ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.locally(currentCtx, ctx)(effect)
```

### 3. `src/services/index.ts`

```typescript
export {
  CloudflareEnv,
  CloudflareCtx,
  CloudflareEnvLive,
  CloudflareCtxLive,
  currentEnv,
  currentCtx,
  withEnv,
  withCtx,
} from "./cloudflare"

export {
  PgDrizzle,
  PgDrizzleLive,
  currentDrizzle,
  withDatabase,
} from "./database"
```

### 4. `src/app.ts`

```typescript
import { Layer } from "effect"
import { HttpGroupsLive } from "./api"
import {
  PgDrizzleLive,
  CloudflareEnvLive,
  CloudflareCtxLive,
} from "./services"

/**
 * Request-scoped services (read from FiberRef)
 */
export const RequestScopedLayer = Layer.mergeAll(
  PgDrizzleLive,
  CloudflareEnvLive,
  CloudflareCtxLive
)

/**
 * API Implementation with dependencies
 */
export const ApiImplementationLayer = HttpGroupsLive.pipe(
  Layer.provide(RequestScopedLayer)
)
```

### 5. `src/handler.ts`

```typescript
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpApiBuilder, HttpServer, OpenApi } from "@effect/platform"
import * as ServerRequest from "@effect/platform/HttpServerRequest"
import * as ServerResponse from "@effect/platform/HttpServerResponse"
import { WorkerApi } from "./definition"
import { ApiImplementationLayer } from "./app"

/**
 * API Layer
 */
const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.api(WorkerApi),
  ApiImplementationLayer,
  HttpServer.layerContext
)

/**
 * Runtime - built ONCE
 */
export const runtime = ManagedRuntime.make(ApiLayer)

/**
 * HTTP app effect
 */
export const httpAppEffect = HttpApiBuilder.httpApp

/**
 * Handle request
 */
export const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    const app = yield* httpAppEffect
    const serverRequest = ServerRequest.fromWeb(request)

    const response = yield* app.pipe(
      Effect.provideService(ServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped
    )

    return ServerResponse.toWeb(response)
  })

export const openApiSpec = OpenApi.fromApi(WorkerApi)
```

### 6. `src/worker.ts`

```typescript
import { Effect } from "effect"
import { runtime, handleRequest, openApiSpec } from "./handler"
import { withDatabase, withEnv, withCtx } from "./services"

/**
 * Wrap effect with all request-scoped resources
 */
const withRequestScope = (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      withDatabase(env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL),
      withEnv(env),
      withCtx(ctx)
    )

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname === "/api/openapi.json") {
      return Response.json(openApiSpec)
    }

    const effect = handleRequest(request).pipe(
      withRequestScope(env, ctx)
    )

    return runtime.runPromise(effect)
  }
}
```

### 7. Handler Example

```typescript
// src/api/groups/UsersGroupLive.ts
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { WorkerApi } from "../../definition"
import { PgDrizzle, CloudflareEnv } from "../../services"
import { users } from "../../db/schema"
import { eq } from "drizzle-orm"

export const UsersGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "users",
  (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle("list", () =>
          Effect.gen(function* () {
            const drizzle = yield* PgDrizzle.PgDrizzle

            // Query returns Effect - no tryPromise needed!
            const results = yield* drizzle.select().from(users)

            return { users: results, total: results.length }
          })
        )
        .handle("get", ({ path: { id } }) =>
          Effect.gen(function* () {
            const drizzle = yield* PgDrizzle.PgDrizzle

            const results = yield* drizzle
              .select()
              .from(users)
              .where(eq(users.id, id))
              .limit(1)

            if (results.length === 0) {
              return yield* Effect.fail(
                new UserNotFoundError({ id, message: `User not found: ${id}` })
              )
            }

            return results[0]
          })
        )
    })
)
```

---

## Key Differences from effect-api-example

| Aspect | effect-api-example | effect-worker |
|--------|-------------------|---------------|
| Runtime | Built once at startup | Built once at startup |
| Database layer | Static (from config) | FiberRef-based (from request env) |
| Connection lifecycle | App lifetime | Request lifetime |
| Connection source | Environment variables | `env.HYPERDRIVE` binding |

---

## Migration Steps

1. Add dependencies: `@effect/sql`, `@effect/sql-drizzle`, `@effect/sql-pg`
2. Delete `src/services/config.ts`, `src/services/kv.ts`, `src/services/storage.ts`
3. Rewrite `src/services/database.ts` (FiberRef + PgDrizzle)
4. Rewrite `src/services/cloudflare.ts` (FiberRef-based)
5. Update `src/services/index.ts`
6. Update `src/app.ts` (remove old services)
7. Update `src/handler.ts` (use runtime)
8. Update `src/worker.ts` (use withRequestScope)
9. Update handlers to use `yield* PgDrizzle.PgDrizzle`
10. Run `pnpm typecheck`

---

## Summary

- **Same pattern as effect-api-example**: `yield* PgDrizzle.PgDrizzle`
- **Queries are Effects**: No `tryPromise` wrappers
- **FiberRef for request scope**: Database instance set per-request
- **Automatic cleanup**: `PgClient` disposed when scope closes
- **Type-safe**: No placeholders or type assertions
