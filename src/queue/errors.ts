/**
 * Queue Error Types
 *
 * Typed errors for queue message processing with retry semantics.
 *
 * @module
 */
import { Schema as S } from "effect";

/**
 * Error when message body fails schema validation.
 * These messages are typically dead-lettered (not retried).
 */
export class QueueMessageDecodeError extends S.TaggedError<QueueMessageDecodeError>()(
  "QueueMessageDecodeError",
  {
    message: S.String,
    messageId: S.String,
    cause: S.Unknown,
  },
) {}

/**
 * Error during message processing.
 * The `retryable` field controls whether the message should be retried.
 *
 * @example
 * ```typescript
 * // Transient error - retry
 * new QueueProcessingError({
 *   message: "Database timeout",
 *   messageId: msg.id,
 *   cause: error,
 *   retryable: true,
 * })
 *
 * // Business logic error - dead-letter
 * new QueueProcessingError({
 *   message: "Invalid order state",
 *   messageId: msg.id,
 *   cause: null,
 *   retryable: false,
 * })
 * ```
 */
export class QueueProcessingError extends S.TaggedError<QueueProcessingError>()(
  "QueueProcessingError",
  {
    message: S.String,
    messageId: S.String,
    cause: S.Unknown,
    retryable: S.Boolean,
  },
) {}
