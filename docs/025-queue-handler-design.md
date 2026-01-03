# 025 - Effect Queue Handler Design

## Overview

Design a clean, Effect-based entry point for Cloudflare Queue handlers that mirrors the elegance of the HTTP middleware pattern while addressing the unique characteristics of queue processing.

## Problem Statement

The current `queue` handler in `src/index.ts` is empty:

```typescript
async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
  for (const message of batch.messages) {
    // TODO
  }
}
```

We need a way to:
1. Process queue messages using pure Effect logic
2. Have batch-scoped resources (database connections)
3. Handle message ack/retry semantics automatically
4. Maintain type safety for message payloads
5. Keep the entry point clean and declarative

## Key Differences: Fetch vs Queue

| Aspect | Fetch Handler | Queue Handler |
|--------|---------------|---------------|
| Input | Single `Request` | `MessageBatch<T>` (multiple messages) |
| Output | `Response` | `void` (ack/retry messages) |
| Routing | HTTP routes via HttpApi | Single handler per queue |
| Middleware | HttpApiMiddleware | Not applicable (no routing) |
| Error handling | HTTP status codes | Message retry/dead-letter |
| Scope | Request lifetime | Batch lifetime |

## Design Goals

1. **Clean Effect API** - Write pure Effect logic, no imperative ack/retry calls
2. **Batch-scoped resources** - Single DB connection per batch (efficient for CF Workers)
3. **Type-safe messages** - Schema validation with Effect Schema
4. **Automatic ack/retry** - Map Effect success/failure to queue semantics
5. **Composable layers** - Reuse same service patterns as fetch handler
6. **Simple entry point** - Declarative, minimal boilerplate

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Queue Entry Point (index.ts)                                │
│                                                             │
│   queue: makeQueueHandler({                                 │
│     schema: MyMessageSchema,                                │
│     handler: (message) => processMessage(message),          │
│   })                                                        │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ makeQueueHandler                                            │
│                                                             │
│   1. Sets FiberRef with env/ctx                             │
│   2. Creates batch-scoped layer (DB connection)             │
│   3. Processes messages with Effect.forEach                 │
│   4. Maps Effect results to ack/retry                       │
│   5. Returns Promise<void>                                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Per-Message Processing                                      │
│                                                             │
│   Schema.decode(message.body)                               │
│       │                                                     │
│       ├─→ Success → handler(decoded) → ack()                │
│       └─→ Failure → retry() or dead-letter                  │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Design

### 1. Queue Service Definitions

```typescript
// src/queue/services.ts

import { Context, Effect, Schema as S } from "effect"

/**
 * Service providing access to the current message being processed.
 * Useful for handlers that need message metadata (id, timestamp, attempts).
 */
export class QueueMessage extends Context.Tag("QueueMessage")<
  QueueMessage,
  {
    readonly id: string
    readonly timestamp: Date
    readonly attempts: number
    readonly body: unknown
  }
>() {}

/**
 * Error types for queue processing.
 */
export class QueueMessageDecodeError extends S.TaggedError<QueueMessageDecodeError>()(
  "QueueMessageDecodeError",
  {
    message: S.String,
    messageId: S.String,
    cause: S.Unknown,
  },
) {}

export class QueueProcessingError extends S.TaggedError<QueueProcessingError>()(
  "QueueProcessingError",
  {
    message: S.String,
    messageId: S.String,
    cause: S.Unknown,
    retryable: S.Boolean,
  },
) {}
```

### 2. Queue Handler Factory

```typescript
// src/queue/handler.ts

import { Effect, Layer, Schema as S, pipe } from "effect"
import { CloudflareBindings, withCloudflareBindings, currentEnv } from "@/services/cloudflare.middleware"
import { DatabaseService, DatabaseMiddlewareLive } from "@/services/database.middleware"

/**
 * Configuration for queue handler behavior.
 */
export interface QueueHandlerConfig<T> {
  /**
   * Schema for validating message bodies.
   * Messages that fail validation are sent to dead-letter (not retried).
   */
  schema: S.Schema<T, unknown>

  /**
   * Handler function that processes a single message.
   * Return Effect.succeed() to ack, Effect.fail() with retryable error to retry.
   */
  handler: (message: T) => Effect.Effect<void, QueueProcessingError, DatabaseService | CloudflareBindings>

  /**
   * Number of messages to process concurrently.
   * Default: 1 (sequential processing)
   */
  concurrency?: number

  /**
   * What to do when message decode fails.
   * - "dead-letter": Ack the message (remove from queue), log error
   * - "retry": Retry the message (may cause infinite loop for bad messages)
   * Default: "dead-letter"
   */
  onDecodeError?: "dead-letter" | "retry"

  /**
   * Custom layer to provide additional services.
   * DatabaseService and CloudflareBindings are provided automatically.
   */
  layer?: Layer.Layer<never, never, any>
}

/**
 * Creates a Cloudflare Queue handler from an Effect-based processor.
 *
 * @example
 * ```typescript
 * // src/index.ts
 * import { makeQueueHandler } from "@/queue/handler"
 * import { UserCreatedEvent, handleUserCreated } from "@/queue/handlers/user-created"
 *
 * export default {
 *   fetch: ...,
 *   queue: makeQueueHandler({
 *     schema: UserCreatedEvent,
 *     handler: handleUserCreated,
 *     concurrency: 5,
 *   }),
 * }
 * ```
 */
export const makeQueueHandler = <T>(
  config: QueueHandlerConfig<T>,
): ExportedHandlerQueueHandler<Env> => {
  const {
    schema,
    handler,
    concurrency = 1,
    onDecodeError = "dead-letter",
  } = config

  return async (batch, env, ctx) => {
    const processMessage = (msg: Message) =>
      Effect.gen(function* () {
        // 1. Decode message body
        const decoded = yield* S.decodeUnknown(schema)(msg.body).pipe(
          Effect.mapError((error) =>
            new QueueMessageDecodeError({
              message: `Failed to decode message: ${error.message}`,
              messageId: msg.id,
              cause: error,
            }),
          ),
        )

        // 2. Process with handler
        yield* handler(decoded).pipe(
          Effect.mapError((error) =>
            new QueueProcessingError({
              message: error.message,
              messageId: msg.id,
              cause: error.cause,
              retryable: error.retryable,
            }),
          ),
        )
      })

    const processWithAckRetry = (msg: Message) =>
      processMessage(msg).pipe(
        // Success: ack the message
        Effect.tap(() => Effect.sync(() => msg.ack())),

        // Handle decode errors
        Effect.catchTag("QueueMessageDecodeError", (error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Message decode failed", error)
            if (onDecodeError === "dead-letter") {
              msg.ack() // Remove from queue
            } else {
              msg.retry()
            }
          }),
        ),

        // Handle processing errors
        Effect.catchTag("QueueProcessingError", (error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Message processing failed", error)
            if (error.retryable) {
              msg.retry()
            } else {
              msg.ack() // Dead-letter: remove from queue
            }
          }),
        ),

        // Catch-all for unexpected errors: retry
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Unexpected error processing message", error)
            msg.retry()
          }),
        ),
      )

    // Build batch-scoped layer
    const batchLayer = makeBatchLayer(env, ctx).pipe(
      Layer.provideMerge(config.layer ?? Layer.empty),
    )

    // Process all messages
    const effect = Effect.forEach(
      batch.messages,
      processWithAckRetry,
      { concurrency },
    ).pipe(
      Effect.provide(batchLayer),
      Effect.scoped,
      withCloudflareBindings(env, ctx),
    )

    return Effect.runPromise(effect)
  }
}

/**
 * Creates batch-scoped layer with database connection.
 * Connection is opened once per batch and closed when batch completes.
 */
const makeBatchLayer = (env: Env, ctx: ExecutionContext) =>
  Layer.mergeAll(
    // CloudflareBindings as a regular service (not middleware)
    Layer.succeed(CloudflareBindings, { env, ctx }),

    // Database connection (batch-scoped)
    makeDatabaseLayer(env),
  )

/**
 * Creates a database layer for queue processing.
 * Similar to DatabaseMiddlewareLive but as a regular Layer.
 */
const makeDatabaseLayer = (env: Env) =>
  Layer.scoped(
    DatabaseService,
    Effect.gen(function* () {
      const connectionString = env.DATABASE_URL ?? LOCAL_DATABASE_URL

      const pgClient = yield* PgClient.make({
        url: Redacted.make(connectionString),
      }).pipe(Effect.provide(Reactivity.layer))

      const drizzle = yield* PgDrizzle.make({
        casing: "snake_case",
      }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

      return { drizzle }
    }),
  )
```

### 3. Example Queue Handlers

```typescript
// src/queue/handlers/user-created.ts

import { Effect, Schema as S } from "effect"
import { DatabaseService } from "@/services/database.middleware"
import { CloudflareBindings } from "@/services/cloudflare.middleware"
import { QueueProcessingError } from "@/queue/services"
import { auditLogs } from "@/db/schema"

/**
 * Schema for user.created queue messages.
 */
export const UserCreatedEvent = S.Struct({
  type: S.Literal("user.created"),
  userId: S.String,
  email: S.String,
  createdAt: S.DateFromString,
})

export type UserCreatedEvent = S.Schema.Type<typeof UserCreatedEvent>

/**
 * Handler for user.created events.
 * Creates audit log entry for new user.
 */
export const handleUserCreated = (
  event: UserCreatedEvent,
): Effect.Effect<void, QueueProcessingError, DatabaseService | CloudflareBindings> =>
  Effect.gen(function* () {
    const { drizzle } = yield* DatabaseService
    const { env } = yield* CloudflareBindings

    // Insert audit log
    yield* Effect.tryPromise({
      try: () =>
        drizzle.insert(auditLogs).values({
          action: "user.created",
          entityId: event.userId,
          metadata: { email: event.email },
          timestamp: event.createdAt,
        }),
      catch: (error) =>
        new QueueProcessingError({
          message: "Failed to insert audit log",
          messageId: event.userId,
          cause: error,
          retryable: true, // DB errors are usually transient
        }),
    })

    yield* Effect.log(`Processed user.created for ${event.userId}`)
  })
```

### 4. Entry Point Integration

```typescript
// src/index.ts

import { runtime, handleRequest, openApiSpec } from "@/runtime"
import { withCloudflareBindings } from "@/services/cloudflare.middleware"
import { makeQueueHandler } from "@/queue/handler"
import { UserCreatedEvent, handleUserCreated } from "@/queue/handlers/user-created"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname === "/api/openapi.json") {
      return Response.json(openApiSpec)
    }

    const effect = handleRequest(request).pipe(
      withCloudflareBindings(env, ctx),
    )

    return runtime.runPromise(effect)
  },

  queue: makeQueueHandler({
    schema: UserCreatedEvent,
    handler: handleUserCreated,
    concurrency: 5,
  }),
} satisfies ExportedHandler<Env>
```

## Alternative: Multi-Schema Queue Handler

For queues that receive multiple message types:

```typescript
// src/queue/handler.ts

/**
 * Handler for queues with multiple message types.
 * Routes messages to appropriate handlers based on discriminator field.
 */
export const makeMultiQueueHandler = <T extends { type: string }>(
  config: {
    schema: S.Schema<T, unknown>
    handlers: {
      [K in T["type"]]: (
        message: Extract<T, { type: K }>,
      ) => Effect.Effect<void, QueueProcessingError, DatabaseService | CloudflareBindings>
    }
    concurrency?: number
  },
): ExportedHandlerQueueHandler<Env> => {
  return makeQueueHandler({
    schema: config.schema,
    handler: (message) => {
      const handler = config.handlers[message.type as T["type"]]
      if (!handler) {
        return Effect.fail(
          new QueueProcessingError({
            message: `No handler for message type: ${message.type}`,
            messageId: "unknown",
            cause: null,
            retryable: false,
          }),
        )
      }
      return handler(message as any)
    },
    concurrency: config.concurrency,
  })
}

// Usage:
const QueueEvent = S.Union(
  UserCreatedEvent,
  OrderPlacedEvent,
  PaymentProcessedEvent,
)

export default {
  queue: makeMultiQueueHandler({
    schema: QueueEvent,
    handlers: {
      "user.created": handleUserCreated,
      "order.placed": handleOrderPlaced,
      "payment.processed": handlePaymentProcessed,
    },
    concurrency: 5,
  }),
}
```

## Resource Lifecycle

```
queue(batch, env, ctx) called
│
├─→ makeBatchLayer(env, ctx)
│     ├─→ CloudflareBindings.layer (immediate)
│     └─→ DatabaseLayer (opens connection)
│
├─→ Effect.forEach(messages, processWithAckRetry)
│     │
│     ├─→ Message 1: decode → handler → ack()
│     ├─→ Message 2: decode → handler → ack()
│     ├─→ Message 3: decode fails → dead-letter
│     ├─→ Message 4: handler fails (retryable) → retry()
│     └─→ Message 5: decode → handler → ack()
│
└─→ Scope ends
      └─→ Database connection closed
```

## Error Handling Strategy

| Error Type | Retryable | Action |
|------------|-----------|--------|
| Schema decode error | No | Ack (dead-letter) |
| Business logic error | No | Ack (dead-letter) |
| Database timeout | Yes | Retry |
| Network error | Yes | Retry |
| Unknown error | Yes | Retry |

```typescript
// Handler can control retry behavior via QueueProcessingError.retryable
const handleMessage = (event: MyEvent) =>
  Effect.gen(function* () {
    // Business validation - don't retry
    if (!isValid(event)) {
      return yield* Effect.fail(
        new QueueProcessingError({
          message: "Invalid event data",
          retryable: false, // Will be dead-lettered
        }),
      )
    }

    // DB operation - retry on failure
    yield* Effect.tryPromise({
      try: () => db.insert(...),
      catch: (error) =>
        new QueueProcessingError({
          message: "DB insert failed",
          retryable: true, // Will be retried
          cause: error,
        }),
    })
  })
```

## Testing

```typescript
// test/queue/handlers/user-created.test.ts

import { Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"
import { handleUserCreated, UserCreatedEvent } from "@/queue/handlers/user-created"
import { DatabaseService } from "@/services/database.middleware"
import { CloudflareBindings } from "@/services/cloudflare.middleware"

const mockDrizzle = {
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue({}),
  }),
}

const TestLayer = Layer.mergeAll(
  Layer.succeed(DatabaseService, { drizzle: mockDrizzle as any }),
  Layer.succeed(CloudflareBindings, { env: {} as Env, ctx: {} as ExecutionContext }),
)

describe("handleUserCreated", () => {
  it("inserts audit log for new user", async () => {
    const event: UserCreatedEvent = {
      type: "user.created",
      userId: "user-123",
      email: "test@example.com",
      createdAt: new Date(),
    }

    await Effect.runPromise(
      handleUserCreated(event).pipe(Effect.provide(TestLayer)),
    )

    expect(mockDrizzle.insert).toHaveBeenCalled()
  })
})
```

## Comparison: Before and After

### Before (Imperative)
```typescript
async queue(batch, env, ctx) {
  const db = await createDbConnection(env.DATABASE_URL)
  try {
    for (const message of batch.messages) {
      try {
        const event = parseMessage(message.body)
        await processEvent(event, db)
        message.ack()
      } catch (error) {
        if (isRetryable(error)) {
          message.retry()
        } else {
          message.ack() // dead-letter
        }
      }
    }
  } finally {
    await db.close()
  }
}
```

### After (Effect)
```typescript
queue: makeQueueHandler({
  schema: UserCreatedEvent,
  handler: (event) =>
    Effect.gen(function* () {
      const { drizzle } = yield* DatabaseService
      yield* drizzle.insert(auditLogs).values({ ... })
    }),
  concurrency: 5,
})
```

## Summary

| Aspect | Design Choice | Rationale |
|--------|---------------|-----------|
| Runtime | Per-batch Layer.provide | Simpler than ManagedRuntime, batch-scoped resources |
| Resource scope | Batch-level | One DB connection per batch (efficient) |
| Message processing | Effect.forEach with concurrency | Parallel processing with control |
| Error handling | Typed errors → ack/retry | Clean mapping to queue semantics |
| Schema validation | Effect Schema | Type-safe, composable |
| Testing | Mock layers | Same pattern as HTTP handlers |

## Next Steps

1. Implement `src/queue/handler.ts` with `makeQueueHandler`
2. Add `QueueProcessingError` to `src/queue/services.ts`
3. Create example handler in `src/queue/handlers/`
4. Update `src/index.ts` to use the new queue handler
5. Add tests for queue handler factory
