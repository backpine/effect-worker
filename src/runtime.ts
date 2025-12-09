import { Layer, ManagedRuntime } from "effect"
import { CloudflareBindings } from "@/services/bindings"
import { AppLive, AppCoreLive } from "@/app"

/**
 * Create core runtime (without Database)
 *
 * Creates a fresh runtime for each request.
 * Effect's layer memoization ensures services are instantiated only once per request.
 *
 * @example
 * ```typescript
 * const runtime = makeCoreRuntime(env, ctx)
 * try {
 *   await runtime.runPromise(myEffect)
 * } finally {
 *   await runtime.dispose()
 * }
 * ```
 */
export const makeCoreRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

/**
 * Create full runtime (with Database)
 *
 * Creates a fresh runtime for each request with database access.
 * Requires HYPERDRIVE binding in your wrangler.toml.
 *
 * @example
 * ```typescript
 * const runtime = makeRuntime(env, ctx)
 * try {
 *   await runtime.runPromise(myEffect)
 * } finally {
 *   await runtime.dispose()
 * }
 * ```
 */
export const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive(env.HYPERDRIVE).pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

/**
 * Type of the core runtime (without Database)
 */
export type CoreAppRuntime = ReturnType<typeof makeCoreRuntime>

/**
 * Type of the full runtime (with Database)
 */
export type AppRuntime = ReturnType<typeof makeRuntime>
