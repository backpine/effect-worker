import { Layer } from "effect"
import {
  ConfigLive,
  KVLive,
  StorageLive,
  DatabaseHyperdrive,
} from "@/services"

/**
 * Core Application Layer (without Database)
 *
 * This layer composes core infrastructure services.
 * Use this when you don't need database access.
 *
 * Services included:
 * - Config
 * - KV (multi-binding)
 * - Storage (multi-binding)
 */
export const AppCoreLive = Layer.mergeAll(
  ConfigLive,
  KVLive,
  StorageLive,
)

/**
 * Application Layer with Database
 *
 * Composes all infrastructure services including Database.
 * Requires Hyperdrive binding from Cloudflare env.
 *
 * @param hyperdrive - Hyperdrive binding from env
 *
 * @example
 * ```typescript
 * const appLayer = AppLive(env.HYPERDRIVE).pipe(
 *   Layer.provide(CloudflareBindings.layer(env, ctx))
 * )
 * ```
 */
export const AppLive = (hyperdrive: Hyperdrive) =>
  Layer.mergeAll(
    AppCoreLive,
    DatabaseHyperdrive(hyperdrive),
  )

/**
 * Application Dependencies Type (Core)
 *
 * This type represents services available without Database.
 */
export type AppCoreDependencies = Layer.Layer.Success<typeof AppCoreLive>

/**
 * Application Dependencies Type (Full)
 *
 * This type represents all services including Database.
 */
export type AppDependencies = Layer.Layer.Success<ReturnType<typeof AppLive>>
