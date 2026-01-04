/**
 * RPC Client Script
 *
 * Demonstrates calling the Users RPC methods.
 *
 * Usage:
 *   npx tsx scripts/rpc-client.ts
 *
 * Make sure the dev server is running:
 *   pnpm dev
 */
import { Effect, Layer, Console } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { UsersRpc } from "../src/rpc/procedures"

const BASE_URL = process.env.RPC_URL ?? "http://localhost:8787/rpc"

// Layer for HTTP client
const HttpClientLive = NodeHttpClient.layerUndici

// Layer for RPC serialization (must match server - using NDJSON)
const SerializationLive = RpcSerialization.layerNdjson

// Create the RPC protocol layer (depends on HttpClient and RpcSerialization)
const ProtocolLive = Layer.effect(
  RpcClient.Protocol,
  Effect.gen(function* () {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.mapRequest(HttpClientRequest.prependUrl(BASE_URL)),
    )
    return yield* RpcClient.makeProtocolHttp(httpClient)
  }),
).pipe(
  Layer.provide(HttpClientLive),
  Layer.provide(SerializationLive),
)

// Combined layer providing all RPC client requirements
const MainLayer = Layer.mergeAll(ProtocolLive, SerializationLive)

const program = Effect.gen(function* () {
  yield* Console.log(`Connecting to RPC server at ${BASE_URL}...`)

  // Create the RPC client
  const client = yield* RpcClient.make(UsersRpc, {
    spanPrefix: "UsersRpcClient",
  })

  yield* Console.log("Connected! Calling RPC methods...\n")

  // Call listUsers
  yield* Console.log("=== Calling listUsers ===")
  const listResult = yield* client.listUsers()
  yield* Console.log(`Found ${listResult.total} users:`)
  for (const user of listResult.users) {
    yield* Console.log(`  - ${user.name} (${user.email}) [${user.id}]`)
  }

  // Call getUser if we have users
  if (listResult.users.length > 0) {
    const firstUser = listResult.users[0]!
    yield* Console.log(`\n=== Calling getUser("${firstUser.id}") ===`)
    const getResult = yield* client.getUser({ id: firstUser.id })
    yield* Console.log(`User details:`)
    yield* Console.log(`  ID: ${getResult.id}`)
    yield* Console.log(`  Name: ${getResult.name}`)
    yield* Console.log(`  Email: ${getResult.email}`)
    yield* Console.log(`  Created: ${getResult.createdAt}`)
  }

  // Try to get a non-existent user
  yield* Console.log(`\n=== Calling getUser("usr_99999") (expecting error) ===`)
  const notFoundResult = yield* client.getUser({ id: "usr_99999" }).pipe(
    Effect.match({
      onSuccess: (user) => `Unexpected success: ${JSON.stringify(user)}`,
      onFailure: (error) => `Expected error: ${JSON.stringify(error)}`,
    }),
  )
  yield* Console.log(notFoundResult)

  // Create a new user
  const timestamp = Date.now()
  yield* Console.log(`\n=== Calling createUser ===`)
  const newUser = yield* client.createUser({
    email: `test-${timestamp}@example.com`,
    name: `Test User ${timestamp}`,
  })
  yield* Console.log(`Created new user:`)
  yield* Console.log(`  ID: ${newUser.id}`)
  yield* Console.log(`  Name: ${newUser.name}`)
  yield* Console.log(`  Email: ${newUser.email}`)

  yield* Console.log("\n=== All RPC calls completed successfully! ===")
})

Effect.runPromise(
  program.pipe(Effect.provide(MainLayer), Effect.scoped),
).catch(console.error)
