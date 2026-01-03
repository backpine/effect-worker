/**
 * Users Endpoint Definition
 *
 * Contains only the endpoint schema definitions, no handler implementation.
 * This separation allows api.ts to import definitions without triggering
 * circular dependencies with handler implementations.
 *
 * ## Schema Validation
 *
 * Effect Schema provides runtime validation with compile-time types:
 * - Branded types (UserId, Email) ensure type safety across the codebase
 * - Pattern validation (email format) runs automatically at request time
 * - Validation errors automatically become HTTP 400 responses
 *
 * ## Middleware
 *
 * DatabaseMiddleware is applied to this group, providing a request-scoped
 * database connection to all handlers via `yield* DatabaseService`.
 *
 * @module
 */
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema as S } from "effect"
import {
  UserSchema,
  UserIdPathSchema,
  CreateUserSchema,
} from "@/http/schemas"
import { UserCreationError, UserNotFoundError } from "@/http/errors"
import { DatabaseMiddleware } from "@/services/database.middleware"

/**
 * Users list response schema.
 */
export const UsersListSchema = S.Struct({
  users: S.Array(UserSchema),
  total: S.Number,
})

/**
 * Users endpoint group definition.
 *
 * DatabaseMiddleware provides request-scoped database connections.
 */
export const UsersGroup = HttpApiGroup.make("users")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(UsersListSchema))
  .add(
    HttpApiEndpoint.get("get", "/:id")
      .setPath(UserIdPathSchema)
      .addSuccess(UserSchema)
      .addError(UserNotFoundError),
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateUserSchema)
      .addSuccess(UserSchema)
      .addError(UserCreationError),
  )
  .middleware(DatabaseMiddleware)
  .prefix("/users")
