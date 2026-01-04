/**
 * RPC Module
 *
 * Type-safe RPC infrastructure for Cloudflare Workers.
 *
 * ## Architecture
 *
 * ```
 * /rpc endpoint → RpcServer
 *   ├── Middleware:
 *   │   ├── RpcCloudflareMiddleware → provides CloudflareBindings
 *   │   └── RpcDatabaseMiddleware → provides DatabaseService
 *   ├── Procedures:
 *   │   └── UsersRpc (getUser, listUsers, createUser)
 *   └── Handlers:
 *       └── UsersRpcHandlersLive
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { rpcWebHandler } from "@/rpc"
 *
 * // In fetch handler:
 * if (url.pathname === "/rpc") {
 *   return rpcWebHandler.handler(request)
 * }
 * ```
 *
 * @module
 */
export * from "./middleware"
export * from "./procedures"
export * from "./handlers"
export { rpcRuntime, handleRpcRequest } from "./runtime"
