/**
 * HTTP API Definition
 *
 * This module defines the structure of the Worker's HTTP API using
 * @effect/platform's HttpApi builder.
 *
 * ## Effect HTTP API Pattern
 *
 * Effect's HttpApi system provides:
 * - Type-safe endpoint definitions with schemas
 * - Automatic request/response validation
 * - OpenAPI specification generation
 * - Composable middleware
 *
 * The API definition is separate from the implementation (handlers).
 * This separation allows:
 * - Client SDK generation from the API definition
 * - Documentation generation without running handlers
 * - Type inference for handler implementations
 *
 * @module
 */
import { HttpApi } from "@effect/platform"
// Import definitions directly to avoid circular dependency with handlers
import { HealthGroup } from "@/http/groups/health.definition"
import { UsersGroup } from "@/http/groups/users.definition"

/**
 * Worker API definition.
 *
 * All endpoints are prefixed with `/api`.
 */
export class WorkerApi extends HttpApi.make("WorkerApi")
  .add(HealthGroup)
  .add(UsersGroup)
  .prefix("/api") {}
