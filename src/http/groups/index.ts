/**
 * HTTP API Groups
 *
 * This module exports all API groups (definitions + handlers).
 *
 * ## File Structure
 *
 * Each endpoint group is split into two files to avoid circular dependencies:
 *
 * - `*.definition.ts` - Endpoint schema definitions (HealthGroup, UsersGroup)
 *   These are imported by api.ts to build the WorkerApi class.
 *
 * - `*.handlers.ts` - Handler implementations (HealthGroupLive, UsersGroupLive)
 *   These import WorkerApi and implement the business logic.
 *
 * This separation ensures api.ts can import definitions without triggering
 * handler imports, which would cause a circular dependency since handlers
 * need to reference WorkerApi.
 *
 * ## Middleware
 *
 * Middleware layers are provided at the runtime level (see runtime.ts).
 * This module only exports handler implementations.
 *
 * @module
 */
import { Layer } from "effect"

// Re-export endpoint definitions (no WorkerApi dependency)
export { HealthGroup } from "./health.definition"
export { UsersGroup } from "./users.definition"

// Re-export handler implementations (import WorkerApi, no circular dependency)
export { HealthGroupLive } from "./health.handlers"
export { UsersGroupLive } from "./users.handlers"

// Import handlers for merging
import { HealthGroupLive } from "./health.handlers"
import { UsersGroupLive } from "./users.handlers"

/**
 * Combined layer of all HTTP group handlers.
 *
 * Middleware is provided at the runtime level (see runtime.ts).
 * Provide this to HttpApiBuilder.api() to register all endpoint handlers.
 */
export const HttpGroupsLive = Layer.mergeAll(
  HealthGroupLive,
  UsersGroupLive,
)
