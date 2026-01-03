/**
 * Health Check Endpoint Definition
 *
 * Contains only the endpoint schema definition, no handler implementation.
 * This separation allows api.ts to import definitions without triggering
 * circular dependencies with handler implementations.
 *
 * @module
 */
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema as S } from "effect";

/**
 * Health check response schema.
 */
export const HealthResponse = S.Struct({
  status: S.Literal("ok"),
  timestamp: S.String,
  environment: S.String,
});

/**
 * Health endpoint group definition.
 */
export const HealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("check", "/health").addSuccess(HealthResponse),
);
