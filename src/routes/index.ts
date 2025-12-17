import * as HttpRouter from "@effect/platform/HttpRouter";
import { healthRoutes } from "./health";
import { usersRoutes } from "./users";

export const routes = HttpRouter.empty.pipe(
  // Mount health routes at /health
  HttpRouter.mount("/health", healthRoutes),

  // Mount user routes at /api/users
  HttpRouter.mount("/api/users", usersRoutes),

  // Add more route modules...
  // HttpRouter.mount("/api/posts", postsRoutes),
);
