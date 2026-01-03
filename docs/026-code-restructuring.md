# 026 - Code Restructuring

## Overview

Now that we have both HTTP and Queue handlers, the code organization needs cleanup. The core issue: **service definitions are mixed with HTTP middleware implementations**.

## Current Structure

```
src/
├── services/
│   ├── cloudflare.middleware.ts   # CloudflareBindings tag + HttpApiMiddleware
│   ├── database.middleware.ts     # DatabaseService tag + HttpApiMiddleware
│   ├── cloudflare.ts              # Legacy FiberRef (deprecated)
│   ├── database.ts                # Legacy FiberRef (deprecated)
│   └── index.ts                   # Re-exports everything
│
├── http/
│   ├── api.ts                     # Imports CloudflareBindingsMiddleware
│   ├── groups/
│   │   └── users.handlers.ts      # Imports DatabaseService from middleware
│   └── ...
│
├── queue/
│   ├── handler.ts                 # Duplicates DB connection logic, imports from middleware
│   ├── handlers/
│   │   └── example.ts             # Imports DatabaseService from middleware
│   └── ...
│
├── runtime.ts
└── index.ts
```

## Problems

### 1. Service Tags Live in Middleware Files

```typescript
// src/queue/handlers/example.ts
import { DatabaseService } from "@/services/database.middleware"  // Confusing!
```

`DatabaseService` is just a `Context.Tag` - it has nothing to do with HTTP middleware. But it lives in `database.middleware.ts` because that's where it was first defined.

### 2. Duplicated Database Connection Logic

```typescript
// src/services/database.middleware.ts (for HTTP)
const pgClient = yield* PgClient.make({ url: ... })
const drizzle = yield* PgDrizzle.make({ ... })

// src/queue/handler.ts (for Queue)
const pgClient = yield* PgClient.make({ url: ... })  // Same code!
const drizzle = yield* PgDrizzle.make({ ... })       // Same code!
```

### 3. Legacy Files Still Exported

```typescript
// src/services/index.ts
// Legacy exports for backwards compatibility (deprecated)
export { getEnv, getCtx, withEnv, withCtx } from "./cloudflare"
export { getDrizzle, withDatabase } from "./database"
```

These are from the FiberRef approach and should be removed.

### 4. import type Issue

```typescript
// src/queue/handlers/example.ts
import type { DatabaseService } from "@/services/database.middleware"  // Wrong!
```

Should be regular import (we yield the service at runtime).

## Recommended Structure

```
src/
├── services/
│   ├── cloudflare.ts              # CloudflareBindings Context.Tag + errors
│   ├── database.ts                # DatabaseService Context.Tag + errors + make fn
│   └── index.ts                   # Re-exports services only
│
├── http/
│   ├── middleware/
│   │   ├── cloudflare.ts          # CloudflareBindingsMiddleware (HTTP-specific)
│   │   ├── database.ts            # DatabaseMiddleware (HTTP-specific)
│   │   └── index.ts
│   ├── api.ts
│   ├── groups/
│   └── ...
│
├── queue/
│   ├── handler.ts                 # makeQueueHandler (uses services/database.ts)
│   ├── errors.ts
│   ├── handlers/
│   └── index.ts
│
├── runtime.ts
└── index.ts
```

## Key Changes

### 1. Extract Service Tags to `src/services/`

**src/services/cloudflare.ts** - Service definition only:
```typescript
import { Context, Schema as S } from "effect"
import { HttpApiSchema } from "@effect/platform"

export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  { readonly env: Env; readonly ctx: ExecutionContext }
>() {}

export class CloudflareBindingsError extends S.TaggedError<CloudflareBindingsError>()(
  "CloudflareBindingsError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}
```

**src/services/database.ts** - Service + shared make function:
```typescript
import { Context, Effect, Redacted, Schema as S } from "effect"
import { HttpApiSchema } from "@effect/platform"
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import * as Reactivity from "@effect/experimental/Reactivity"
import * as SqlClient from "@effect/sql/SqlClient"

export type DrizzleInstance = PgRemoteDatabase<Record<string, never>>

export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  { readonly drizzle: DrizzleInstance }
>() {}

export class DatabaseConnectionError extends S.TaggedError<DatabaseConnectionError>()(
  "DatabaseConnectionError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

/**
 * Create a scoped database connection.
 * Used by both HTTP middleware and Queue handlers.
 */
export const makeDatabaseConnection = (connectionString: string) =>
  Effect.gen(function* () {
    const pgClient = yield* PgClient.make({
      url: Redacted.make(connectionString),
    }).pipe(Effect.provide(Reactivity.layer))

    const drizzle = yield* PgDrizzle.make({
      casing: "snake_case",
    }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

    return { drizzle }
  })
```

### 2. Move Middleware to `src/http/middleware/`

**src/http/middleware/database.ts**:
```typescript
import { HttpApiMiddleware } from "@effect/platform"
import { Effect, FiberRef, Layer } from "effect"
import {
  DatabaseService,
  DatabaseConnectionError,
  makeDatabaseConnection
} from "@/services/database"
import { currentEnv } from "./cloudflare"

export class DatabaseMiddleware extends HttpApiMiddleware.Tag<DatabaseMiddleware>()(
  "DatabaseMiddleware",
  { failure: DatabaseConnectionError, provides: DatabaseService },
) {}

export const DatabaseMiddlewareLive = Layer.effect(
  DatabaseMiddleware,
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv)
      if (env === null) {
        return yield* Effect.fail(new DatabaseConnectionError({ message: "..." }))
      }
      return yield* makeDatabaseConnection(env.DATABASE_URL ?? LOCAL_URL)
    }).pipe(Effect.catchAll(...))
  }),
)
```

### 3. Queue Uses Shared Service

**src/queue/handler.ts**:
```typescript
import { DatabaseService, makeDatabaseConnection } from "@/services/database"
import { CloudflareBindings } from "@/services/cloudflare"

const makeDatabaseLayer = (env: Env) =>
  Layer.scoped(
    DatabaseService,
    makeDatabaseConnection(env.DATABASE_URL ?? LOCAL_URL),
  )
```

### 4. Clean Imports

**Before:**
```typescript
// Confusing - importing service from middleware file
import { DatabaseService } from "@/services/database.middleware"
```

**After:**
```typescript
// Clear - service from services, middleware from http
import { DatabaseService } from "@/services/database"
import { DatabaseMiddleware } from "@/http/middleware/database"
```

### 5. Delete Legacy Files

Remove:
- `src/services/cloudflare.ts` (old FiberRef version)
- `src/services/database.ts` (old FiberRef version)

These are replaced by the new structure.

## Migration Steps

1. Create `src/services/cloudflare.ts` with just the service tag + error
2. Create `src/services/database.ts` with service tag + error + `makeDatabaseConnection`
3. Create `src/http/middleware/` directory
4. Move middleware implementations to `src/http/middleware/cloudflare.ts` and `database.ts`
5. Update imports in:
   - `src/http/api.ts`
   - `src/http/groups/*.handlers.ts`
   - `src/queue/handler.ts`
   - `src/queue/handlers/*.ts`
   - `src/runtime.ts`
6. Delete old `src/services/cloudflare.ts` and `src/services/database.ts`
7. Update `src/services/index.ts` to only export service tags
8. Fix `import type` → `import` in `src/queue/handlers/example.ts`

## Summary

| Before | After |
|--------|-------|
| Services mixed with HTTP middleware | Services separate from implementation |
| Queue imports from `*.middleware.ts` | Queue imports from `@/services/*` |
| Duplicated DB connection logic | Shared `makeDatabaseConnection` |
| Legacy FiberRef exports | Removed |
| `import type { DatabaseService }` | `import { DatabaseService }` |
