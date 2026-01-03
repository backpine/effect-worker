/**
 * HTTP API Errors
 *
 * Error types for the HTTP API with automatic status code mapping.
 *
 * ## Effect TaggedError Pattern
 *
 * Using S.TaggedError provides:
 * - Type-safe error discrimination via _tag
 * - Automatic serialization for HTTP responses
 * - HttpApiSchema.annotations for status codes
 *
 * @module
 */
import { HttpApiSchema } from "@effect/platform";
import { Schema as S } from "effect";
import { UserIdSchema } from "@/http/schemas/user";

/**
 * Error returned when a user creation fails.
 *
 * HTTP Status: 400 Bad Request
 */
export class UserCreationError extends S.TaggedError<UserCreationError>()(
  "UserCreationError",
  {
    email: S.String,
    name: S.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

/**
 * Error returned when a user is not found.
 *
 * HTTP Status: 404 Not Found
 */
export class UserNotFoundError extends S.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  {
    id: UserIdSchema,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

/**
 * Error returned for invalid request data.
 *
 * HTTP Status: 400 Bad Request
 */
export class ApiValidationError extends S.TaggedError<ApiValidationError>()(
  "ApiValidationError",
  {
    message: S.String,
    errors: S.Array(S.String),
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

/**
 * Generic error returned when a resource or route is not found.
 *
 * HTTP Status: 404 Not Found
 */
export class NotFoundError extends S.TaggedError<NotFoundError>()(
  "NotFoundError",
  {
    path: S.String,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}
