import * as HttpApp from "@effect/platform/HttpApp";
import { Layer, ManagedRuntime } from "effect";
import { appRouter } from "./router";
import { AppCoreLive } from "./app";
import { CloudflareBindings } from "@/services";

/**
 * Cloudflare Worker Entry Point
 *
 * Uses @effect/platform HttpRouter for routing with Effect for business logic.
 * Routes are defined in src/routes/
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Create the application layer with Cloudflare bindings
    const bindingsLayer = CloudflareBindings.layer(env, ctx);
    const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer));

    // Create managed runtime for this request
    const managedRuntime = ManagedRuntime.make(appLayer);

    try {
      // Get the runtime and create handler
      const rt = await managedRuntime.runtime();
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter);
      return await handler(request);
    } finally {
      // Cleanup runtime after request
      ctx.waitUntil(managedRuntime.dispose());
    }
  },
};
