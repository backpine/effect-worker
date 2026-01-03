/**
 * Users Endpoint Handlers
 *
 * Handler implementations for the users endpoints.
 * Uses DatabaseService provided by DatabaseMiddleware.
 *
 * @module
 */
import { HttpApiBuilder } from "@effect/platform"
import { DateTime, Effect } from "effect"
import { UserId, Email, User } from "@/http/schemas"
import { UserCreationError, UserNotFoundError } from "@/http/errors"
import { WorkerApi } from "@/http/api"
import { DatabaseService } from "@/services/database.middleware"
import { users } from "@/db"
import { eq } from "drizzle-orm"

/**
 * Convert database user id to UserId format.
 */
const toUserId = (id: number): UserId => `usr_${id}` as UserId

/**
 * Parse UserId to extract the database id.
 */
const parseUserId = (id: UserId): number | null => {
  const match = id.match(/^usr_(\d+)$/)
  return match ? parseInt(match[1]!, 10) : null
}

/**
 * Users endpoint handler implementation.
 */
export const UsersGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "users",
  (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle("list", () =>
          Effect.gen(function* () {
            // Access DatabaseService (provided by DatabaseMiddleware)
            const { drizzle } = yield* DatabaseService
            const dbUsers = yield* drizzle
              .select()
              .from(users)
              .pipe(Effect.catchAll(() => Effect.succeed([])))

            const userList: User[] = dbUsers.map((u) => ({
              id: toUserId(u.id),
              email: u.email as Email,
              name: u.name,
              createdAt: DateTime.unsafeFromDate(u.createdAt),
            }))

            return {
              users: userList,
              total: userList.length,
            }
          }),
        )

        .handle("get", ({ path: { id } }) =>
          Effect.gen(function* () {
            const dbId = parseUserId(id)
            if (dbId === null) {
              return yield* Effect.fail(
                new UserNotFoundError({
                  id,
                  message: `Invalid user ID format: ${id}`,
                }),
              )
            }

            const { drizzle } = yield* DatabaseService
            const [dbUser] = yield* drizzle
              .select()
              .from(users)
              .where(eq(users.id, dbId))
              .pipe(
                Effect.catchAll(() =>
                  Effect.fail(
                    new UserNotFoundError({
                      id,
                      message: `User not found: ${id}`,
                    }),
                  ),
                ),
              )

            if (!dbUser) {
              return yield* Effect.fail(
                new UserNotFoundError({
                  id,
                  message: `User not found: ${id}`,
                }),
              )
            }

            return {
              id: toUserId(dbUser.id),
              email: dbUser.email as Email,
              name: dbUser.name,
              createdAt: DateTime.unsafeFromDate(dbUser.createdAt),
            } satisfies User
          }),
        )
        .handle("create", ({ payload: { email, name } }) =>
          Effect.gen(function* () {
            const { drizzle } = yield* DatabaseService
            const [newUser] = yield* drizzle
              .insert(users)
              .values({ email, name })
              .returning()
              .pipe(
                Effect.catchAll(() =>
                  Effect.fail(new UserCreationError({ email, name })),
                ),
              )

            if (!newUser) {
              return yield* Effect.fail(new UserCreationError({ email, name }))
            }

            return {
              id: toUserId(newUser.id),
              email: newUser.email as Email,
              name: newUser.name,
              createdAt: DateTime.unsafeFromDate(newUser.createdAt),
            } satisfies User
          }),
        )
    }),
)
