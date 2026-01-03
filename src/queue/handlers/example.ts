/**
 * Example Queue Handler
 *
 * Simple example that validates and logs queue messages.
 *
 * @module
 */
import { Effect, Schema as S } from "effect";
import { QueueProcessingError } from "@/queue/errors";
import { DatabaseService } from "@/services/database";
import { CloudflareBindings } from "@/services/cloudflare";

// ============================================================================
// Message Schema
// ============================================================================

/**
 * Example event schema.
 * Replace with your actual message schema.
 */
export const ExampleEvent = S.Struct({
  type: S.String,
  payload: S.Unknown,
});

export type ExampleEvent = S.Schema.Type<typeof ExampleEvent>;

// ============================================================================
// Handler
// ============================================================================

/**
 * Example handler that logs the event.
 */
export const handleExampleEvent = (
  event: ExampleEvent,
): Effect.Effect<
  void,
  QueueProcessingError,
  DatabaseService | CloudflareBindings
> =>
  Effect.gen(function* () {
    yield* Effect.log("Processing queue message", { event });
  });
