import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { Effect, Option } from "effect"
import { Storage, KV } from "@/services"
import { NotFoundError } from "@/errors"
import {
  UserIdParams,
  CreateUserBody,
  UpdateUserBody,
  UserResponse,
} from "./schemas"

export const usersRoutes = HttpRouter.empty.pipe(
  // ---------------------------------------------------------------------------
  // GET /users - List all users
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/",
    HttpServerResponse.json({
      users: [],
      message: "Implement with your schema",
    })
  ),

  // ---------------------------------------------------------------------------
  // GET /users/:id - Get user by ID
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)

      // const db = yield* Database
      // const user = yield* db.query(...)
      // if (!user) return yield* Effect.fail(new NotFoundError({ resource: "User", id }))

      return yield* Effect.fail(new NotFoundError({ resource: "User", id }))
    })
  ),

  // ---------------------------------------------------------------------------
  // POST /users - Create new user
  // ---------------------------------------------------------------------------
  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      // Schema validates and parses the body automatically
      // Returns ParseError if validation fails
      const body = yield* HttpServerRequest.schemaBodyJson(CreateUserBody)

      // body is now typed: { email: string, name: string, age?: number }
      const user = {
        id: crypto.randomUUID(),
        email: body.email,
        name: body.name,
        createdAt: new Date().toISOString(),
      }

      // const db = yield* Database
      // const inserted = yield* db.insert(...)

      // Validate response matches schema (optional but recommended)
      return yield* HttpServerResponse.schemaJson(UserResponse)(user)
    })
  ),

  // ---------------------------------------------------------------------------
  // PUT /users/:id - Update user
  // ---------------------------------------------------------------------------
  HttpRouter.put(
    "/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const body = yield* HttpServerRequest.schemaBodyJson(UpdateUserBody)

      // body is typed: { email?: string, name?: string, age?: number }

      // const db = yield* Database
      // const user = yield* db.update(...)
      // if (!user) return yield* Effect.fail(new NotFoundError({ resource: "User", id }))

      return yield* HttpServerResponse.json({ id, ...body, updated: true })
    })
  ),

  // ---------------------------------------------------------------------------
  // DELETE /users/:id - Delete user
  // ---------------------------------------------------------------------------
  HttpRouter.del(
    "/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)

      // const db = yield* Database
      // const deleted = yield* db.delete(...)
      // if (!deleted) return yield* Effect.fail(new NotFoundError({ resource: "User", id }))

      return yield* HttpServerResponse.json({ deleted: true, id })
    })
  ),

  // ---------------------------------------------------------------------------
  // GET /users/:id/avatar - Get user avatar from Object Storage
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/:id/avatar",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const storage = yield* Storage

      const key = `users/${id}/avatar`
      const file = yield* storage.from("MY_BUCKET").get(key)

      return yield* Option.match(file, {
        onNone: () =>
          Effect.fail(new NotFoundError({ resource: "Avatar", id })),
        onSome: (body) =>
          Effect.succeed(
            HttpServerResponse.raw(body.body, {
              headers: {
                "Content-Type": body.httpMetadata?.contentType ?? "image/png",
                ETag: body.httpEtag,
                "Cache-Control": "public, max-age=3600",
              },
            })
          ),
      })
    })
  ),

  // ---------------------------------------------------------------------------
  // GET /users/:id/preferences - Get user preferences from KV
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/:id/preferences",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.schemaPathParams(UserIdParams)
      const kv = yield* KV

      const key = `user:${id}:preferences`
      const value = yield* kv.from("MY_KV").get(key)

      return yield* Option.match(value, {
        onNone: () =>
          HttpServerResponse.json({
            userId: id,
            preferences: {
              theme: "light",
              notifications: true,
              language: "en",
            },
            isDefault: true,
          }),
        onSome: (v) =>
          HttpServerResponse.json({
            userId: id,
            preferences: JSON.parse(v),
            isDefault: false,
          }),
      })
    })
  )
)
