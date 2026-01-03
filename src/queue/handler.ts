/**
 * Queue Handler Factory
 *
 * Creates Effect-based Cloudflare Queue handlers with automatic:
 * - Batch-scoped resource management (DB connections)
 * - Schema validation for message bodies
 * - Ack/retry mapping based on Effect success/failure
 *
 * ## Usage
 *
 * ```typescript
 * // src/index.ts
 * import { makeQueueHandler } from "@/queue/handler"
 *
 * export default {
 *   queue: makeQueueHandler({
 *     schema: MyEventSchema,
 *     handler: (event) =>
 *       Effect.gen(function* () {
 *         const { drizzle } = yield* DatabaseService
 *         yield* Effect.log("Processing event", event)
 *       }),
 *     concurrency: 5,
 *   }),
 * }
 * ```
 *
 * @module
 */
import { Effect, Layer, Schema as S } from "effect";
import {
  CloudflareBindings,
  withCloudflareBindings,
} from "@/services/cloudflare";
import {
  DatabaseService,
  makeDatabaseConnection,
  LOCAL_DATABASE_URL,
} from "@/services/database";
import { QueueMessageDecodeError, QueueProcessingError } from "./errors";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for queue handler.
 */
export interface QueueHandlerConfig<T, I, R> {
  /**
   * Schema for validating message bodies.
   * Messages that fail validation are dead-lettered (not retried).
   */
  schema: S.Schema<T, I>;

  /**
   * Handler function that processes a single decoded message.
   * - Return Effect.succeed() to ack the message
   * - Return Effect.fail(QueueProcessingError) to control retry behavior
   */
  handler: (message: T) => Effect.Effect<void, QueueProcessingError, R>;

  /**
   * Number of messages to process concurrently.
   * @default 1
   */
  concurrency?: number;

  /**
   * What to do when message decode fails.
   * - "dead-letter": Ack the message (remove from queue), log error
   * - "retry": Retry the message (may cause infinite loop for bad messages)
   * @default "dead-letter"
   */
  onDecodeError?: "dead-letter" | "retry";
}

// ============================================================================
// Handler Factory
// ============================================================================

/**
 * Creates a Cloudflare Queue handler from an Effect-based processor.
 *
 * Resources (database connections) are scoped to the batch - one connection
 * is opened when the batch starts and closed when it completes.
 *
 * @example
 * ```typescript
 * const MyEvent = S.Struct({
 *   type: S.Literal("my.event"),
 *   data: S.String,
 * })
 *
 * export default {
 *   queue: makeQueueHandler({
 *     schema: MyEvent,
 *     handler: (event) =>
 *       Effect.gen(function* () {
 *         yield* Effect.log("Processing", event)
 *       }),
 *   }),
 * }
 * ```
 */
export const makeQueueHandler = <T, I>(
  config: QueueHandlerConfig<T, I, DatabaseService | CloudflareBindings>,
): ExportedHandlerQueueHandler<Env> => {
  const { schema, handler, concurrency = 1, onDecodeError = "dead-letter" } = config;

  return async (batch, env, ctx) => {
    const processMessage = (msg: Message) =>
      Effect.gen(function* () {
        // 1. Decode message body with schema
        const decoded = yield* S.decodeUnknown(schema)(msg.body).pipe(
          Effect.mapError(
            (error) =>
              new QueueMessageDecodeError({
                message: `Failed to decode message: ${error.message}`,
                messageId: msg.id,
                cause: error,
              }),
          ),
        );

        // 2. Process with handler
        yield* handler(decoded);
      });

    const processWithAckRetry = (msg: Message) =>
      processMessage(msg).pipe(
        // Success: ack the message
        Effect.tap(() => Effect.sync(() => msg.ack())),

        // Handle decode errors
        Effect.catchTag("QueueMessageDecodeError", (error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Message decode failed", { error });
            if (onDecodeError === "dead-letter") {
              msg.ack(); // Remove from queue
            } else {
              msg.retry();
            }
          }),
        ),

        // Handle processing errors
        Effect.catchTag("QueueProcessingError", (error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Message processing failed", { error });
            if (error.retryable) {
              msg.retry();
            } else {
              msg.ack(); // Dead-letter: remove from queue
            }
          }),
        ),

        // Catch-all for unexpected errors: retry
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Unexpected error processing message", {
              error,
            });
            msg.retry();
          }),
        ),
      );

    // Build batch-scoped layer
    const batchLayer = makeBatchLayer(env, ctx);

    // Process all messages
    const effect = Effect.forEach(batch.messages, processWithAckRetry, {
      concurrency,
      discard: true,
    }).pipe(
      Effect.provide(batchLayer),
      Effect.scoped,
      withCloudflareBindings(env, ctx),
    );

    return Effect.runPromise(effect);
  };
};

// ============================================================================
// Batch Layer
// ============================================================================

/**
 * Creates batch-scoped layer with CloudflareBindings and DatabaseService.
 * Resources are created once per batch and cleaned up when batch completes.
 */
const makeBatchLayer = (env: Env, ctx: ExecutionContext) =>
  Layer.mergeAll(
    // CloudflareBindings as a regular service
    Layer.succeed(CloudflareBindings, { env, ctx }),

    // Database connection (batch-scoped)
    makeDatabaseLayer(env),
  );

/**
 * Creates a scoped database layer for queue processing.
 */
const makeDatabaseLayer = (env: Env) =>
  Layer.scoped(
    DatabaseService,
    makeDatabaseConnection(env.DATABASE_URL ?? LOCAL_DATABASE_URL),
  );
