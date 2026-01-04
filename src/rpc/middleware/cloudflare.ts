/**
 * Cloudflare Bindings RPC Middleware
 *
 * RpcMiddleware that provides CloudflareBindings to RPC handlers.
 *
 * @module
 */
import { RpcMiddleware } from "@effect/rpc"
import { Effect, FiberRef, Layer } from "effect"
import {
  CloudflareBindings,
  CloudflareBindingsError,
  currentEnv,
  currentCtx,
} from "@/services/cloudflare"

// ============================================================================
// Middleware Definition
// ============================================================================

/**
 * Middleware that provides CloudflareBindings to RPC handlers.
 *
 * Apply to RPC procedures that need access to Cloudflare env/ctx:
 *
 * ```typescript
 * const myRpc = Rpc.make("myRpc", { ... })
 *   .middleware(RpcCloudflareMiddleware)
 * ```
 */
export class RpcCloudflareMiddleware extends RpcMiddleware.Tag<RpcCloudflareMiddleware>()(
  "RpcCloudflareMiddleware",
  {
    failure: CloudflareBindingsError,
    provides: CloudflareBindings,
  },
) {}

// ============================================================================
// Middleware Implementation
// ============================================================================

/**
 * Live implementation of RpcCloudflareMiddleware.
 *
 * Reads env/ctx from FiberRef and provides them as the CloudflareBindings service.
 */
export const RpcCloudflareMiddlewareLive = Layer.succeed(
  RpcCloudflareMiddleware,
  // Middleware function runs per-RPC-call
  () =>
    Effect.gen(function* () {
      const env = yield* FiberRef.get(currentEnv)
      const ctx = yield* FiberRef.get(currentCtx)

      if (env === null || ctx === null) {
        return yield* Effect.fail(
          new CloudflareBindingsError({
            message:
              "Cloudflare bindings not available. Ensure withCloudflareBindings() wraps the handler.",
          }),
        )
      }

      return { env, ctx }
    }),
)
