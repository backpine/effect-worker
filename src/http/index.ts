/**
 * HTTP API Module
 *
 * Public exports for the HTTP API layer.
 *
 * ## Module Structure
 *
 * - `api.ts` - HttpApi definition (WorkerApi)
 * - `groups/` - Endpoint definitions and handlers
 * - `schemas/` - Request/response schemas
 * - `errors/` - API error types
 *
 * @module
 */
export { WorkerApi } from "./api"
export * from "./groups"
export * from "./schemas"
export * from "./errors"
