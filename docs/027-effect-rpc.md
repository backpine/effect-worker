# RPC Integration Design for Effect Worker

This document explores how to add `@effect/rpc` support to effect-worker while maintaining request-scoped dependency injection compatible with Cloudflare Workers constraints.

## Executive Summary

Effect RPC provides type-safe, schema-validated remote procedure calls with built-in support for streaming, middleware, and client generation. Integrating it with effect-worker requires careful consideration of Cloudflare's request isolation constraints - the same fundamental challenge we solved for HTTP with `HttpApiMiddleware`.

**Key Insight**: RPC has its own middleware system (`RpcMiddleware`) that supports the `provides` option for injecting request-scoped services. This mirrors `HttpApiMiddleware` exactly, making integration straightforward.

## Background: Effect RPC Architecture

### Core Components

```
@effect/rpc
├── Rpc.ts           # Individual procedure definitions
├── RpcGroup.ts      # Groups of related procedures
├── RpcMiddleware.ts # Per-request middleware with service injection
├── RpcServer.ts     # Server-side handling (HTTP, WebSocket, Worker protocols)
├── RpcClient.ts     # Type-safe client generation
├── RpcSchema.ts     # Stream schema for bi-directional streaming
└── RpcSerialization.ts # Message encoding (JSON, MessagePack, etc.)
```

### Procedure Definition

```typescript
import { Rpc, RpcGroup } from "@effect/rpc"
import * as S from "effect/Schema"

// Define individual procedures
const getUser = Rpc.make("getUser", {
  payload: { id: S.String },
  success: S.Struct({ id: S.String, name: S.String, email: S.String }),
  error: S.Struct({ _tag: S.Literal("NotFound"), id: S.String }),
})

const createUser = Rpc.make("createUser", {
  payload: { name: S.String, email: S.String },
  success: S.Struct({ id: S.String, name: S.String, email: S.String }),
  error: S.Struct({ _tag: S.Literal("DuplicateEmail"), email: S.String }),
})

// Group procedures with optional middleware
const UsersGroup = RpcGroup.make(getUser, createUser)
```

### RpcMiddleware with `provides`

RpcMiddleware works identically to HttpApiMiddleware for service injection:

```typescript
import * as RpcMiddleware from "@effect/rpc/RpcMiddleware"

// Define middleware that provides a service
class DatabaseMiddleware extends RpcMiddleware.Tag<DatabaseMiddleware>()(
  "DatabaseMiddleware",
  {
    failure: DatabaseConnectionError,    // Error type
    provides: DatabaseService,           // Service to inject
  },
) {}
```

### Server Integration

```typescript
import { RpcServer } from "@effect/rpc"

// Create HTTP app from RpcGroup
const httpApp = RpcServer.toHttpApp(UsersGroup, {
  spanPrefix: "UsersRpc",
})

// Or create a web handler directly
const { handler, dispose } = RpcServer.toWebHandler(UsersGroup, {
  layer: HandlersLayer.pipe(Layer.provide(MiddlewareLayers)),
})
```

## The Cloudflare Workers Constraint

Same challenge as HTTP: Cloudflare Workers cannot share TCP connections between requests.

```
Cloudflare Worker Isolation:
┌─────────────────────────────────────────────────────────────┐
│ RPC Request 1: [open DB conn] → [query] → [close DB conn]  │
│ RPC Request 2: [open DB conn] → [query] → [close DB conn]  │
│ RPC Request 3: [open DB conn] → [query] → [close DB conn]  │
│                                                             │
│ Each RPC call needs its own database connection!           │
└─────────────────────────────────────────────────────────────┘
```

**Solution**: Use `RpcMiddleware` with `provides` - the same pattern as `HttpApiMiddleware`.

## Integration Design

### Option 1: Parallel Stack (Recommended)

Run RPC alongside HTTP, each with their own endpoints.

```
Cloudflare Worker Entry Point
│
├── /api/*        → HTTP (HttpApi + HttpApiMiddleware)
│   └── Existing REST endpoints
│
└── /rpc or /rpc/* → RPC (RpcGroup + RpcMiddleware)
    └── Type-safe RPC procedures
```

**Pros:**
- Clear separation of concerns
- Can incrementally migrate endpoints
- Clients choose their preferred interface
- No interference with existing HTTP patterns

**Cons:**
- Two middleware stacks to maintain (though they share FiberRef bridge)
- Slightly more boilerplate

### Option 2: RPC-Only

Replace HTTP with RPC entirely.

**Pros:**
- Single, unified API surface
- Maximum type-safety with generated clients
- Simpler mental model

**Cons:**
- Breaking change for existing consumers
- Loses REST semantics (some teams prefer REST)
- WebSocket-based RPC may not work with all CDN/proxy configurations

### Option 3: RPC as Implementation, HTTP as Facade

Use RPC internally but expose HTTP endpoints that delegate to RPC handlers.

**Pros:**
- Best of both worlds
- Single implementation, dual interface

**Cons:**
- Complexity overhead
- May be over-engineered for most use cases

**Recommendation**: Start with Option 1 (parallel stack). It provides the most flexibility and allows incremental adoption.

## Implementation Plan

### Phase 1: RpcMiddleware for Request-Scoped Services

Create RPC-specific middleware that mirrors our HTTP middleware pattern:

```typescript
// src/rpc/middleware/cloudflare.ts
import * as RpcMiddleware from "@effect/rpc/RpcMiddleware"
import { CloudflareBindings, CloudflareBindingsError, currentEnv, currentCtx } from "@/services/cloudflare"

/**
 * RPC Middleware that provides CloudflareBindings to handlers.
 */
export class RpcCloudflareMiddleware extends RpcMiddleware.Tag<RpcCloudflareMiddleware>()(
  "RpcCloudflareMiddleware",
  {
    failure: CloudflareBindingsError,
    provides: CloudflareBindings,
  },
) {}

export const RpcCloudflareMiddlewareLive = Layer.effect(
  RpcCloudflareMiddleware,
  Effect.succeed(
    // Middleware function runs per-RPC-call
    () => Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv)
      const ctx = yield* FiberRef.get(currentCtx)

      if (env === null || ctx === null) {
        return yield* Effect.fail(
          new CloudflareBindingsError({
            message: "Cloudflare bindings not available",
          }),
        )
      }

      return { env, ctx }
    })
  ),
)
```

```typescript
// src/rpc/middleware/database.ts
import * as RpcMiddleware from "@effect/rpc/RpcMiddleware"
import { DatabaseService, DatabaseConnectionError, makeDatabaseConnection, LOCAL_DATABASE_URL } from "@/services/database"
import { currentEnv } from "@/services/cloudflare"

/**
 * RPC Middleware that provides DatabaseService to handlers.
 */
export class RpcDatabaseMiddleware extends RpcMiddleware.Tag<RpcDatabaseMiddleware>()(
  "RpcDatabaseMiddleware",
  {
    failure: DatabaseConnectionError,
    provides: DatabaseService,
  },
) {}

export const RpcDatabaseMiddlewareLive = Layer.effect(
  RpcDatabaseMiddleware,
  Effect.succeed(
    // Middleware function runs per-RPC-call
    () => Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv)
      if (env === null) {
        return yield* Effect.fail(
          new DatabaseConnectionError({
            message: "Cloudflare env not available",
          }),
        )
      }

      const connectionString = env.DATABASE_URL ?? LOCAL_DATABASE_URL
      return yield* makeDatabaseConnection(connectionString)
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(new DatabaseConnectionError({
          message: `Database connection failed: ${String(error)}`,
        })),
      ),
    )
  ),
)
```

### Phase 2: Define RPC Procedures

```typescript
// src/rpc/procedures/users.ts
import { Rpc, RpcGroup } from "@effect/rpc"
import * as S from "effect/Schema"
import { RpcDatabaseMiddleware } from "@/rpc/middleware/database"

// Schema definitions (can reuse from HTTP)
const UserSchema = S.Struct({
  id: S.String,
  email: S.String,
  name: S.String,
  createdAt: S.DateFromString,
})

const UserNotFoundError = S.Struct({
  _tag: S.Literal("UserNotFound"),
  id: S.String,
  message: S.String,
})

// Procedure definitions
export const getUser = Rpc.make("getUser", {
  payload: { id: S.String },
  success: UserSchema,
  error: UserNotFoundError,
}).middleware(RpcDatabaseMiddleware)

export const listUsers = Rpc.make("listUsers", {
  payload: S.Void,
  success: S.Struct({
    users: S.Array(UserSchema),
    total: S.Number,
  }),
}).middleware(RpcDatabaseMiddleware)

export const createUser = Rpc.make("createUser", {
  payload: { email: S.String, name: S.String },
  success: UserSchema,
  error: S.Union(
    S.Struct({ _tag: S.Literal("DuplicateEmail"), email: S.String }),
    S.Struct({ _tag: S.Literal("ValidationError"), message: S.String }),
  ),
}).middleware(RpcDatabaseMiddleware)

// Group procedures
export const UsersRpc = RpcGroup.make(getUser, listUsers, createUser)
```

### Phase 3: Implement Handlers

```typescript
// src/rpc/handlers/users.ts
import { Effect } from "effect"
import { UsersRpc } from "@/rpc/procedures/users"
import { DatabaseService } from "@/services/database"
import { users } from "@/db"
import { eq } from "drizzle-orm"

export const UsersHandlersLive = UsersRpc.toLayer({
  getUser: ({ id }) =>
    Effect.gen(function* () {
      const { drizzle } = yield* DatabaseService

      const [user] = yield* drizzle
        .select()
        .from(users)
        .where(eq(users.id, parseInt(id.replace("usr_", ""))))

      if (!user) {
        return yield* Effect.fail({
          _tag: "UserNotFound" as const,
          id,
          message: `User ${id} not found`,
        })
      }

      return {
        id: `usr_${user.id}`,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      }
    }),

  listUsers: () =>
    Effect.gen(function* () {
      const { drizzle } = yield* DatabaseService

      const dbUsers = yield* drizzle.select().from(users)

      return {
        users: dbUsers.map(u => ({
          id: `usr_${u.id}`,
          email: u.email,
          name: u.name,
          createdAt: u.createdAt,
        })),
        total: dbUsers.length,
      }
    }),

  createUser: ({ email, name }) =>
    Effect.gen(function* () {
      const { drizzle } = yield* DatabaseService

      const [newUser] = yield* drizzle
        .insert(users)
        .values({ email, name })
        .returning()
        .pipe(
          Effect.catchAll(() =>
            Effect.fail({
              _tag: "DuplicateEmail" as const,
              email,
            }),
          ),
        )

      if (!newUser) {
        return yield* Effect.fail({
          _tag: "ValidationError" as const,
          message: "Failed to create user",
        })
      }

      return {
        id: `usr_${newUser.id}`,
        email: newUser.email,
        name: newUser.name,
        createdAt: newUser.createdAt,
      }
    }),
})
```

### Phase 4: Create RPC Server Runtime

```typescript
// src/rpc/runtime.ts
import { Effect, Layer, ManagedRuntime } from "effect"
import { RpcServer, RpcSerialization } from "@effect/rpc"
import { UsersRpc, UsersHandlersLive } from "./procedures/users"
import { RpcCloudflareMiddlewareLive, RpcDatabaseMiddlewareLive } from "./middleware"

// Combine all RPC groups
export const AllRpcGroups = UsersRpc
// .merge(OrdersRpc)
// .merge(ProductsRpc)

// Combined handlers
const AllHandlersLive = Layer.mergeAll(
  UsersHandlersLive,
  // OrdersHandlersLive,
  // ProductsHandlersLive,
)

// Middleware layers
const MiddlewareLive = Layer.mergeAll(
  RpcCloudflareMiddlewareLive,
  RpcDatabaseMiddlewareLive,
)

// Serialization (JSON for HTTP compatibility)
const SerializationLive = RpcSerialization.layerJson

// Create the RPC HTTP app
export const makeRpcHttpApp = RpcServer.toHttpApp(AllRpcGroups, {
  spanPrefix: "RpcServer",
  disableFatalDefects: false,
})

// Create web handler for Cloudflare Workers
export const rpcWebHandler = RpcServer.toWebHandler(AllRpcGroups, {
  layer: AllHandlersLive.pipe(
    Layer.provide(MiddlewareLive),
    Layer.provide(SerializationLive),
  ),
  spanPrefix: "RpcServer",
})
```

### Phase 5: Entry Point Integration

```typescript
// src/index.ts
import { runtime, handleRequest, openApiSpec } from "@/runtime"
import { rpcWebHandler } from "@/rpc/runtime"
import { withCloudflareBindings } from "@/services/cloudflare"
import { makeQueueHandler } from "@/queue"
import { ExampleEvent, handleExampleEvent } from "@/queue/handlers/example"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    // Serve OpenAPI spec
    if (url.pathname === "/api/openapi.json") {
      return Response.json(openApiSpec)
    }

    // RPC endpoint (HTTP POST)
    if (url.pathname === "/rpc" || url.pathname.startsWith("/rpc/")) {
      // Set FiberRef for middleware to read
      return rpcWebHandler.handler(request, Context.empty().pipe(
        // Bridge Cloudflare bindings via FiberRef
        // Note: rpcWebHandler needs to run with withCloudflareBindings
      ))
    }

    // REST API (existing)
    const effect = handleRequest(request).pipe(
      withCloudflareBindings(env, ctx),
    )
    return runtime.runPromise(effect)
  },

  queue: makeQueueHandler({
    schema: ExampleEvent,
    handler: handleExampleEvent,
    concurrency: 5,
  }),
} satisfies ExportedHandler<Env>
```

### Alternative: Using toHttpApp with Existing Runtime

If you want to integrate RPC into the existing ManagedRuntime:

```typescript
// src/rpc/server.ts
import { Effect } from "effect"
import { RpcServer, RpcSerialization } from "@effect/rpc"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { AllRpcGroups, AllHandlersLive, MiddlewareLive } from "./runtime"

/**
 * Handle RPC request using the shared runtime.
 */
export const handleRpcRequest = (request: Request) =>
  Effect.gen(function* () {
    // Create scoped RPC app
    const rpcApp = yield* RpcServer.toHttpApp(AllRpcGroups).pipe(
      Effect.provide(AllHandlersLive),
      Effect.provide(MiddlewareLive),
      Effect.provide(RpcSerialization.layerJson),
    )

    // Convert web request to Effect platform request
    const serverRequest = HttpServerRequest.fromWeb(request)

    // Handle and return web response
    const response = yield* rpcApp.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped,
    )

    return HttpServerResponse.toWeb(response)
  })
```

## Request-Scoped DI Flow

The flow mirrors HTTP middleware exactly:

```
RPC Request arrives
│
├─→ withCloudflareBindings(env, ctx)
│     └─→ Sets FiberRef.locally(currentEnv, env)
│     └─→ Sets FiberRef.locally(currentCtx, ctx)
│
└─→ RpcServer handles request
      │
      ├─→ RpcCloudflareMiddleware runs
      │     └─→ FiberRef.get(currentEnv)
      │     └─→ FiberRef.get(currentCtx)
      │     └─→ Provides CloudflareBindings service
      │
      ├─→ RpcDatabaseMiddleware runs
      │     └─→ FiberRef.get(currentEnv) → gets DATABASE_URL
      │     └─→ makeDatabaseConnection() (scoped)
      │     └─→ Provides DatabaseService
      │
      ├─→ Handler executes
      │     └─→ yield* DatabaseService → fresh connection
      │     └─→ yield* CloudflareBindings → env, ctx
      │
      └─→ Response returned
            └─→ Scope closes
            └─→ Database connection released
```

## Type Safety Benefits

RPC provides end-to-end type safety:

```typescript
// Client (auto-generated from RpcGroup)
import { RpcClient } from "@effect/rpc"

const client = yield* RpcClient.make(UsersRpc, {
  // ... protocol configuration
})

// Fully typed!
const user = yield* client.getUser({ id: "usr_123" })
//    ^? { id: string, email: string, name: string, createdAt: Date }

// Errors are typed too
const result = yield* client.createUser({ email: "test@example.com", name: "Test" }).pipe(
  Effect.catchTag("DuplicateEmail", (err) => {
    console.log(err.email) // Typed!
    return Effect.succeed(null)
  }),
)
```

## Streaming Support

RPC supports bi-directional streaming via WebSocket:

```typescript
// Stream procedure definition
const watchUsers = Rpc.make("watchUsers", {
  payload: S.Void,
  success: UserSchema,      // Stream of users
  error: S.Never,
  stream: true,             // Marks this as streaming
})

// Handler returns a Stream
const watchUsersHandler = () =>
  Stream.fromEffect(DatabaseService).pipe(
    Stream.flatMap(({ drizzle }) =>
      // Hypothetical reactive query
      drizzle.subscribe(users)
    ),
    Stream.map(user => ({
      id: `usr_${user.id}`,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    })),
  )
```

**Note**: WebSocket-based streaming may have limitations with Cloudflare Workers. Durable Objects might be required for long-lived connections.

## Project Structure

```
src/
├── index.ts                        # Worker entry point (HTTP + RPC)
├── runtime.ts                      # HTTP ManagedRuntime
├── services/
│   ├── cloudflare.ts               # CloudflareBindings + FiberRef bridge
│   └── database.ts                 # DatabaseService + connection factory
├── http/                           # Existing HTTP infrastructure
│   ├── api.ts
│   ├── middleware/
│   │   ├── cloudflare.ts           # HttpApiMiddleware
│   │   └── database.ts             # HttpApiMiddleware
│   └── groups/
├── rpc/                            # NEW: RPC infrastructure
│   ├── runtime.ts                  # RPC server setup
│   ├── middleware/
│   │   ├── cloudflare.ts           # RpcMiddleware (reuses FiberRef bridge)
│   │   └── database.ts             # RpcMiddleware (reuses connection factory)
│   ├── procedures/
│   │   ├── users.ts                # User RPC definitions
│   │   └── index.ts                # All groups merged
│   └── handlers/
│       ├── users.ts                # User RPC implementations
│       └── index.ts                # All handlers merged
├── queue/                          # Existing queue infrastructure
└── db/
    └── schema.ts                   # Drizzle schema
```

## Key Observations

### Shared Patterns

1. **FiberRef Bridge**: Same `currentEnv`/`currentCtx` FiberRefs work for both HTTP and RPC
2. **Service Definitions**: `DatabaseService`, `CloudflareBindings` are protocol-agnostic
3. **Connection Factory**: `makeDatabaseConnection()` works for both middleware types
4. **Error Types**: Can share error schema definitions

### Differences

| Aspect | HTTP (HttpApiMiddleware) | RPC (RpcMiddleware) |
|--------|--------------------------|---------------------|
| **Definition** | `HttpApiMiddleware.Tag` | `RpcMiddleware.Tag` |
| **Apply To** | `HttpApiGroup.middleware()` | `Rpc.middleware()` or `RpcGroup.middleware()` |
| **Provides** | Via `provides` option | Via `provides` option |
| **Routing** | Path-based (`/users/:id`) | Tag-based (`getUser`) |
| **Client** | REST/OpenAPI | Auto-generated type-safe client |
| **Streaming** | SSE, chunked encoding | Native bi-directional (WebSocket) |

## Migration Path

1. **Phase 1**: Add RPC infrastructure alongside HTTP (no breaking changes)
2. **Phase 2**: Expose RPC endpoint at `/rpc`
3. **Phase 3**: Generate client SDK from RpcGroup
4. **Phase 4**: Migrate internal services to use RPC client
5. **Phase 5**: (Optional) Deprecate HTTP endpoints if fully migrated

## Testing

RPC handlers can be tested the same way as HTTP:

```typescript
// Mock middleware
const MockDatabaseMiddlewareLive = Layer.succeed(
  RpcDatabaseMiddleware,
  () => Effect.succeed({ drizzle: mockDrizzle }),
)

// Test layer
const TestLayer = UsersHandlersLive.pipe(
  Layer.provide(MockDatabaseMiddlewareLive),
)

// Or use RpcTest for in-memory testing
import { RpcTest } from "@effect/rpc"

const testClient = yield* RpcTest.make(UsersRpc).pipe(
  Effect.provide(UsersHandlersLive),
  Effect.provide(MockDatabaseMiddlewareLive),
)

const user = yield* testClient.getUser({ id: "usr_1" })
expect(user.name).toBe("Test User")
```

## Conclusion

Adding RPC support to effect-worker is straightforward because:

1. **RpcMiddleware mirrors HttpApiMiddleware** - the `provides` pattern translates directly
2. **FiberRef bridge is reusable** - same `currentEnv`/`currentCtx` pattern
3. **Service layer is protocol-agnostic** - `DatabaseService`, connection factory work unchanged
4. **Incremental adoption is possible** - run RPC alongside HTTP on different paths

The main implementation work is:
1. Create RpcMiddleware versions of existing HttpApiMiddleware
2. Define RpcGroup with procedures
3. Implement handlers using existing services
4. Wire up entry point routing

This provides a type-safe, schema-validated RPC layer with the same request-scoped DI guarantees as the existing HTTP infrastructure.
