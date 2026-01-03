import { faker } from "@faker-js/faker"
import { Effect, Redacted } from "effect"
import * as Reactivity from "@effect/experimental/Reactivity"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import { PgClient } from "@effect/sql-pg"
import * as SqlClient from "@effect/sql/SqlClient"
import { users } from "../src/db/schema"

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/effect_worker"
const USER_COUNT = 50

const seed = Effect.gen(function* () {
  yield* Effect.logInfo(`Connecting to database...`)

  const pgClient = yield* PgClient.make({
    url: Redacted.make(DATABASE_URL),
  }).pipe(Effect.provide(Reactivity.layer))

  const db = yield* PgDrizzle.make({
    casing: "snake_case",
  }).pipe(Effect.provideService(SqlClient.SqlClient, pgClient))

  yield* Effect.logInfo(`Clearing existing users...`)
  yield* db.delete(users)

  yield* Effect.logInfo(`Seeding ${USER_COUNT} users...`)

  const userData = Array.from({ length: USER_COUNT }, () => ({
    email: faker.internet.email().toLowerCase(),
    name: faker.person.fullName(),
  }))

  const batchSize = 10
  for (let i = 0; i < userData.length; i += batchSize) {
    const batch = userData.slice(i, i + batchSize)
    yield* db.insert(users).values(batch)
    yield* Effect.logInfo(`Inserted ${Math.min(i + batchSize, USER_COUNT)} / ${USER_COUNT}`)
  }

  yield* Effect.logInfo("Seeding complete!")
})

Effect.runPromise(Effect.scoped(seed)).catch(console.error)
