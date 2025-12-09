import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { Effect } from "effect"
import { Config } from "@/services"

export const healthRoutes = HttpRouter.empty.pipe(
  // ---------------------------------------------------------------------------
  // GET /health - Basic health check
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/",
    HttpServerResponse.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
    })
  ),

  // ---------------------------------------------------------------------------
  // GET /health/config - Config health check
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/config",
    Effect.gen(function* () {
      const config = yield* Config
      const env = yield* config.getOrElse("ENVIRONMENT", "unknown")
      return yield* HttpServerResponse.json({ environment: env })
    })
  )
)
