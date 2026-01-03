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
 * @module
 */
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema as S } from "effect";
import {
  UserSchema,
  UserIdPathSchema,
  CreateUserSchema,
} from "@/http/schemas";
import { UserCreationError, UserNotFoundError } from "@/http/errors";

/**
 * Users list response schema.
 */
export const UsersListSchema = S.Struct({
  users: S.Array(UserSchema),
  total: S.Number,
});

/**
 * Users endpoint group definition.
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
  .prefix("/users");
