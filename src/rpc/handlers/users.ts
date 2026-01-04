/**
 * Users RPC Handlers
 *
 * Handler implementations for the users RPC procedures.
 * Uses DatabaseService provided by RpcDatabaseMiddleware.
 *
 * @module
 */
import { DateTime, Effect } from "effect"
import { UsersRpc } from "@/rpc/procedures"
import { DatabaseService } from "@/services/database"
import { users } from "@/db"
import { eq } from "drizzle-orm"

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert database user id to string format.
 */
const toUserId = (id: number): string => `usr_${id}`

/**
 * Parse user ID to extract the database id.
 */
const parseUserId = (id: string): number | null => {
  const match = id.match(/^usr_(\d+)$/)
  return match ? parseInt(match[1]!, 10) : null
}

// ============================================================================
// Handler Implementation
// ============================================================================

/**
 * Users RPC handler layer.
 */
export const UsersRpcHandlersLive = UsersRpc.toLayer({
  getUser: ({ id }) =>
    Effect.gen(function* () {
      const dbId = parseUserId(id)
      if (dbId === null) {
        return yield* Effect.fail({
          _tag: "UserNotFound" as const,
          id,
          message: `Invalid user ID format: ${id}`,
        })
      }

      const { drizzle } = yield* DatabaseService
      const [dbUser] = yield* drizzle
        .select()
        .from(users)
        .where(eq(users.id, dbId))
        .pipe(
          Effect.catchAll(() =>
            Effect.fail({
              _tag: "UserNotFound" as const,
              id,
              message: `User not found: ${id}`,
            }),
          ),
        )

      if (!dbUser) {
        return yield* Effect.fail({
          _tag: "UserNotFound" as const,
          id,
          message: `User not found: ${id}`,
        })
      }

      return {
        id: toUserId(dbUser.id),
        email: dbUser.email,
        name: dbUser.name,
        createdAt: DateTime.unsafeFromDate(dbUser.createdAt),
      }
    }),

  listUsers: () =>
    Effect.gen(function* () {
      const { drizzle } = yield* DatabaseService
      const dbUsers = yield* drizzle
        .select()
        .from(users)
        .pipe(Effect.catchAll(() => Effect.succeed([])))

      return {
        users: dbUsers.map((u) => ({
          id: toUserId(u.id),
          email: u.email,
          name: u.name,
          createdAt: DateTime.unsafeFromDate(u.createdAt),
        })),
        total: dbUsers.length,
      }
    }),

  createUser: ({ email, name }) =>
    Effect.gen(function* () {
      const { drizzle } = yield* DatabaseService
      const [newUser] = yield* drizzle
        .insert(users)
        .values({ email, name })
        .returning()
        .pipe(
          Effect.catchAll(() =>
            Effect.fail({
              _tag: "DuplicateEmail" as const,
              email,
            }),
          ),
        )

      if (!newUser) {
        return yield* Effect.fail({
          _tag: "ValidationError" as const,
          message: "Failed to create user",
        })
      }

      return {
        id: toUserId(newUser.id),
        email: newUser.email,
        name: newUser.name,
        createdAt: DateTime.unsafeFromDate(newUser.createdAt),
      }
    }),
})
