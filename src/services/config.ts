import { Context, Effect, Layer } from "effect"
import { Schema } from "effect"
import { CloudflareBindings } from "@/services/bindings"
import { ConfigError } from "@/errors"

/**
 * Config Service Interface
 *
 * Provides type-safe access to environment variables and secrets.
 * All methods return Effects that can fail with ConfigError.
 */
export interface ConfigService {
  /**
   * Get a string config value
   */
  readonly get: (key: string) => Effect.Effect<string, ConfigError>

  /**
   * Get a secret value (same as get, but semantically different)
   */
  readonly getSecret: (key: string) => Effect.Effect<string, ConfigError>

  /**
   * Get a numeric config value
   */
  readonly getNumber: (key: string) => Effect.Effect<number, ConfigError>

  /**
   * Get a boolean config value
   * Accepts: "true", "false", "1", "0", "yes", "no"
   */
  readonly getBoolean: (key: string) => Effect.Effect<boolean, ConfigError>

  /**
   * Get a JSON config value with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<A, ConfigError, R>

  /**
   * Get a config value with a default fallback
   */
  readonly getOrElse: (
    key: string,
    defaultValue: string
  ) => Effect.Effect<string, never>

  /**
   * Get all config as a record (useful for debugging)
   */
  readonly getAll: () => Effect.Effect<Record<string, string>, never>
}

/**
 * Config Service Tag
 */
export class Config extends Context.Tag("Config")<Config, ConfigService>() {}

/**
 * Live Config Implementation
 *
 * Backed by Cloudflare's env object.
 * Values are read from environment variables and secrets.
 */
export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    // Helper to get raw value from env
    const getRaw = (key: string): string | undefined => {
      const value = env[key as keyof typeof env]
      return typeof value === "string" ? value : undefined
    }

    const service: ConfigService = {
      get: (key: string) =>
        Effect.fromNullable(getRaw(key)).pipe(
          Effect.mapError(
            () =>
              new ConfigError({
                key,
                message: `Config key "${key}" not found`,
              })
          )
        ),

      getSecret: (key: string) =>
        Effect.fromNullable(getRaw(key)).pipe(
          Effect.mapError(
            () =>
              new ConfigError({
                key,
                message: `Secret "${key}" not found`,
              })
          )
        ),

      getNumber: (key: string) =>
        Effect.gen(function* () {
          const value = yield* service.get(key)
          const num = Number(value)

          if (Number.isNaN(num)) {
            return yield* Effect.fail(
              new ConfigError({
                key,
                message: `Config key "${key}" is not a valid number: "${value}"`,
              })
            )
          }

          return num
        }),

      getBoolean: (key: string) =>
        Effect.gen(function* () {
          const value = yield* service.get(key)
          const lower = value.toLowerCase().trim()

          if (["true", "1", "yes"].includes(lower)) return true
          if (["false", "0", "no"].includes(lower)) return false

          return yield* Effect.fail(
            new ConfigError({
              key,
              message: `Config key "${key}" is not a valid boolean: "${value}"`,
            })
          )
        }),

      getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
        Effect.gen(function* () {
          const value = yield* service.get(key)

          const parsed = yield* Effect.try({
            try: () => JSON.parse(value) as unknown,
            catch: (error) =>
              new ConfigError({
                key,
                message: `Config key "${key}" is not valid JSON: ${error}`,
              }),
          })

          return yield* Schema.decodeUnknown(schema)(parsed).pipe(
            Effect.mapError(
              (parseError) =>
                new ConfigError({
                  key,
                  message: `Config key "${key}" failed schema validation: ${parseError}`,
                })
            )
          )
        }),

      getOrElse: (key: string, defaultValue: string) =>
        service.get(key).pipe(Effect.orElseSucceed(() => defaultValue)),

      getAll: () =>
        Effect.sync(() => {
          const result: Record<string, string> = {}
          for (const key in env) {
            const value = env[key as keyof typeof env]
            if (typeof value === "string") {
              result[key] = value
            }
          }
          return result
        }),
    }

    return service
  })
)
