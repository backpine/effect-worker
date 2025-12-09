import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { DatabaseError } from "@/errors";
import { Config } from "./config";

/**
 * DrizzleClient type
 *
 * This is the type of the Drizzle client instance.
 * When you have a schema, update this to include it:
 *
 * ```typescript
 * import * as schema from "@/db/schema"
 * export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>
 * ```
 */
export type DrizzleClient = ReturnType<typeof drizzle>;

/**
 * Database Service
 *
 * Provides access to the Drizzle client.
 * The client is memoized once per request via Effect's layer system.
 *
 * **Usage:**
 * ```typescript
 * const db = yield* Database
 * const users = await db.select().from(usersTable)
 * ```
 *
 * **Or use the query helper:**
 * ```typescript
 * const users = yield* query((db) =>
 *   db.select().from(usersTable).where(eq(usersTable.id, id))
 * )
 * ```
 */
export class Database extends Context.Tag("Database")<
  Database,
  DrizzleClient
>() {}

/**
 * Query helper
 *
 * Wraps database operations in Effects with proper error handling.
 * Automatically injects the Database client and adds tracing.
 *
 * @example
 * ```typescript
 * const getUser = (id: string) =>
 *   query((db) =>
 *     db.select().from(users).where(eq(users.id, id)).limit(1)
 *   )
 *
 * // In your Effect.gen:
 * const users = yield* getUser("123")
 * ```
 */
export const query = <T>(
  fn: (db: DrizzleClient) => Promise<T>,
): Effect.Effect<T, DatabaseError, Database> =>
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* Effect.tryPromise({
      try: () => fn(db),
      catch: (error) =>
        new DatabaseError({
          message: "Database query failed",
          cause: error,
        }),
    });
  }).pipe(
    Effect.withSpan("database.query", {
      attributes: { "db.system": "postgresql" },
    }),
  );

/**
 * Creates a Database layer from a connection string with proper cleanup.
 *
 * Use for local development with a direct PostgreSQL connection.
 * Connections are properly closed when the runtime is disposed.
 *
 * @param connectionString - PostgreSQL connection URL
 *
 * @example
 * ```typescript
 * const DbLayer = DatabaseLive("postgres://user:pass@localhost:5432/mydb")
 * ```
 */
export const DatabaseLive = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const client = postgres(connectionString, {
        max: 5,
        fetch_types: false,
      });

      const db = drizzle(client);

      // Register cleanup to close connections when runtime disposes
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await client.end({ timeout: 5 });
        }).pipe(Effect.catchAll(() => Effect.void)),
      );

      return db;
    }),
  );

/**
 * Creates a Database layer from Cloudflare Hyperdrive with proper cleanup.
 *
 * Use in production on Cloudflare Workers for connection pooling.
 * Connections are properly closed when the runtime is disposed.
 *
 * @param hyperdrive - Hyperdrive binding from Cloudflare env
 *
 * @example
 * ```typescript
 * const DbLayer = DatabaseHyperdrive(env.HYPERDRIVE)
 * ```
 */
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const client = postgres(hyperdrive.connectionString, {
        max: 5,
        fetch_types: false,
      });

      const db = drizzle(client);

      // Register cleanup to close connections when runtime disposes
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await client.end({ timeout: 5 });
        }).pipe(Effect.catchAll(() => Effect.void)),
      );

      return db;
    }),
  );

/**
 * Creates a Database layer using Config service to get connection string.
 *
 * Reads DATABASE_URL from the Config service.
 * Useful when you want the connection string from environment variables.
 * Connections are properly closed when the runtime is disposed.
 *
 * @example
 * ```typescript
 * const AppLive = Layer.mergeAll(
 *   ConfigLive,
 *   DatabaseFromConfig,
 * )
 * ```
 */
export const DatabaseFromConfig = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const config = yield* Config;
    const connectionString = yield* config.get("DATABASE_URL");

    const client = postgres(connectionString, {
      max: 5,
      fetch_types: false,
    });

    const db = drizzle(client);

    // Register cleanup to close connections when runtime disposes
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await client.end({ timeout: 5 });
      }).pipe(Effect.catchAll(() => Effect.void)),
    );

    return db;
  }),
);
