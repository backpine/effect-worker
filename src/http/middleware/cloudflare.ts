/**
 * Cloudflare Bindings HTTP Middleware
 *
 * HttpApiMiddleware that provides CloudflareBindings to HTTP handlers.
 *
 * @module
 */
import { HttpApiMiddleware } from "@effect/platform";
import { Effect, FiberRef, Layer } from "effect";
import {
  CloudflareBindings,
  CloudflareBindingsError,
  currentEnv,
  currentCtx,
} from "@/services/cloudflare";

// ============================================================================
// Middleware Definition
// ============================================================================

/**
 * Middleware that provides CloudflareBindings to HTTP handlers.
 *
 * Apply at the API level to make env/ctx available everywhere:
 *
 * ```typescript
 * export class WorkerApi extends HttpApi.make("WorkerApi")
 *   .add(UsersGroup)
 *   .middleware(CloudflareBindingsMiddleware)
 *   .prefix("/api") {}
 * ```
 */
export class CloudflareBindingsMiddleware extends HttpApiMiddleware.Tag<CloudflareBindingsMiddleware>()(
  "CloudflareBindingsMiddleware",
  {
    failure: CloudflareBindingsError,
    provides: CloudflareBindings,
  },
) {}

// ============================================================================
// Middleware Implementation
// ============================================================================

/**
 * Live implementation of CloudflareBindingsMiddleware.
 *
 * Reads env/ctx from FiberRef and provides them as the CloudflareBindings service.
 */
export const CloudflareBindingsMiddlewareLive = Layer.effect(
  CloudflareBindingsMiddleware,
  Effect.gen(function* () {
    // Return the middleware effect (runs per-request)
    return Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv);
      const ctx = yield* FiberRef.get(currentCtx);

      if (env === null || ctx === null) {
        return yield* Effect.fail(
          new CloudflareBindingsError({
            message:
              "Cloudflare bindings not available. Ensure withCloudflareBindings() wraps the handler.",
          }),
        );
      }

      return { env, ctx };
    });
  }),
);
