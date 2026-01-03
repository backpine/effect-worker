# Handler-Scoped Database Connections

Exploring an alternative to wrapping every request with database scope.

## The Feedback

> I'd almost rather pipe request-scoped layers directly to each handler implementation to be more explicit and not bubble up the requirement or create database connections for requests where I don't need them.

This is a valid concern. Currently we do this:

```
fetch(request, env, ctx)
  └─> withDatabase(env.DATABASE_URL)   ← Opens connection for EVERY request
        └─> withEnv(env)
              └─> handleRequest(request)
                    ├─> GET /api/health     ← Doesn't need database
                    ├─> GET /api/users      ← Needs database
                    └─> POST /api/users     ← Needs database
```

The health check endpoint opens and closes a database connection it never uses.

## What We Want

```
fetch(request, env, ctx)
  └─> withEnv(env)
        └─> handleRequest(request)
              ├─> GET /api/health     ← No database connection
              ├─> GET /api/users      ← Opens connection, queries, closes
              └─> POST /api/users     ← Opens connection, queries, closes
```

Only handlers that need the database should open a connection.

---

## Approach 1: Handler-Level withDatabase

Wrap individual handler effects with `withDatabase`:

```typescript
// Current: FiberRef accessor
.handle("list", () =>
  Effect.gen(function* () {
    const db = yield* getDrizzle  // Reads from FiberRef set at request level
    // ...
  })
)

// Proposed: Scoped at handler level
.handle("list", () =>
  withDatabase(getDatabaseUrl())(
    Effect.gen(function* () {
      const db = yield* getDrizzle
      // ...
    })
  )
)
```

### Problem: How do we get DATABASE_URL?

The handler doesn't have access to `env`. We'd need to:

1. Read `env` from FiberRef first
2. Then open the database connection

```typescript
.handle("list", () =>
  Effect.gen(function* () {
    const env = yield* getEnv
    const url = env.DATABASE_URL ?? LOCAL_DATABASE_URL

    return yield* withDatabase(url)(
      Effect.gen(function* () {
        const db = yield* getDrizzle
        // ...
      })
    )
  })
)
```

This works but is verbose. Every database handler repeats this boilerplate.

---

## Approach 2: Helper for Database Handlers

Create a helper that combines env access + database scoping:

```typescript
// services/database.ts
export const withScopedDatabase = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const env = yield* getEnv
    const url = env.DATABASE_URL ?? LOCAL_DATABASE_URL
    return yield* withDatabase(url)(effect)
  })
```

Usage in handlers:

```typescript
.handle("list", () =>
  withScopedDatabase(
    Effect.gen(function* () {
      const db = yield* getDrizzle
      const users = yield* db.select().from(usersTable)
      return { users, total: users.length }
    })
  )
)
```

### Pros
- Explicit: you can see which handlers need database
- Efficient: no connection for health checks
- Composable: just wrap the effect

### Cons
- Still uses FiberRef (no compile-time safety)
- Boilerplate wrapper on every database handler
- Easy to forget the wrapper

---

## Approach 3: Database as Layer Requirement

What if handlers declared their database dependency in the type system?

```typescript
// Define a Database service (not FiberRef)
class Database extends Context.Tag("Database")<
  Database,
  DrizzleInstance
>() {}

// Handler has Database in R (requirements)
const listUsers: Effect.Effect<UserList, never, Database> =
  Effect.gen(function* () {
    const db = yield* Database
    // ...
  })

// At handler registration, provide the layer
.handle("list", () =>
  listUsers.pipe(
    Effect.provide(DatabaseLive)  // Scoped layer provided here
  )
)
```

### The Challenge: Scoped Layers

`DatabaseLive` needs to be a scoped layer that:
1. Opens a connection
2. Provides the service
3. Closes when the handler effect completes

```typescript
const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const env = yield* getEnv
    const url = env.DATABASE_URL ?? LOCAL_DATABASE_URL

    const pgClient = yield* PgClient.make({
      url: Redacted.make(url),
    }).pipe(Effect.provide(Reactivity.layer))

    const drizzle = yield* PgDrizzle.make({
      casing: "snake_case",
    }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

    return drizzle
  })
)
```

### Problem: Layer Requires Env

`DatabaseLive` depends on `getEnv` (FiberRef). This creates a weird hybrid:
- `Env` comes from FiberRef (set at request level)
- `Database` is a proper Layer/Tag

But this might be okay? The `Env` FiberRef is lightweight (no I/O), so setting it for every request is fine. Only the database connection is expensive.

---

## Approach 4: Request Context Layer

What if we created a minimal "request context" layer per-request, and handlers that need database provide their own scoped layer on top?

```typescript
// Lightweight: just env and ctx, no database
const RequestContextLive = (env: Env, ctx: ExecutionContext) =>
  Layer.mergeAll(
    Layer.succeed(CloudflareEnv, env),
    Layer.succeed(CloudflareCtx, ctx),
  )

// Heavy: database connection, created only when needed
const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const env = yield* CloudflareEnv
    return yield* makeConnection(env.DATABASE_URL)
  })
)
```

At the handler level:

```typescript
.handle("list", () =>
  listUsers.pipe(
    Effect.provide(DatabaseLive)  // Opens connection for this handler only
  )
)

.handle("health", () =>
  healthCheck  // No database layer provided
)
```

### The Type Safety Win

With this approach, `listUsers` has type:

```typescript
Effect<UserList, ApiError, Database>
//                          ^^^^^^^^
//                          Compile error if not provided!
```

If you forget `Effect.provide(DatabaseLive)`, TypeScript complains.

---

## Comparison

| Approach | Type Safety | Efficiency | Boilerplate |
|----------|-------------|------------|-------------|
| Current (FiberRef at request level) | ❌ Runtime | ❌ All requests | Low |
| Handler withDatabase wrapper | ❌ Runtime | ✅ Only DB handlers | Medium |
| Database as Layer + provide | ✅ Compile | ✅ Only DB handlers | Medium |
| Request Context + DB Layer | ✅ Compile | ✅ Only DB handlers | Higher |

---

## Open Questions

### 1. Does Layer.scoped work inside handlers?

When you call `Effect.provide(DatabaseLive)` inside a handler, does the scoped resource (TCP connection) get cleaned up when the handler effect completes?

Need to verify this works correctly with HttpApiBuilder's effect lifecycle.

### 2. Performance of per-handler Layer.provide?

Is there overhead to calling `Effect.provide(layer)` on each handler invocation? The layer itself is scoped (creates connection each time), but is there additional cost?

### 3. Can we share the pattern?

If multiple handlers need database, they all do:

```typescript
.handle("list", () => listUsers.pipe(Effect.provide(DatabaseLive)))
.handle("get", () => getUser.pipe(Effect.provide(DatabaseLive)))
.handle("create", () => createUser.pipe(Effect.provide(DatabaseLive)))
```

Could we create a helper like:

```typescript
const withDb = <A, E>(effect: Effect<A, E, Database>) =>
  effect.pipe(Effect.provide(DatabaseLive))

.handle("list", () => withDb(listUsers))
.handle("get", () => withDb(getUser))
```

### 4. How does this interact with ManagedRuntime?

The ApiLayer is still memoized in ManagedRuntime. Handler effects run within that runtime. When a handler does `Effect.provide(DatabaseLive)`:

- Does the scoped layer work correctly?
- Is the connection properly cleaned up?
- Any issues with fiber scope boundaries?

---

## Next Steps

1. **Prototype Approach 3**: Try `Database` as a Context.Tag with Layer.scoped, provided at handler level

2. **Verify cleanup**: Ensure TCP connections close when handler completes

3. **Measure overhead**: Compare performance of FiberRef vs per-handler Layer.provide

4. **Consider hybrid**: Maybe `Env` stays as FiberRef (cheap), but `Database` becomes a proper Layer (expensive, type-safe)
