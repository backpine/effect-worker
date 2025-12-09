import { Context, Effect, Layer, Option } from "effect"
import { Schema } from "effect"
import { CloudflareBindings } from "./bindings"
import { StorageError } from "@/errors"
import type { R2BindingName } from "./types"

/**
 * Operations available on an R2 bucket
 */
export interface StorageOperations {
  /**
   * Get an object by key
   */
  readonly get: (key: string) => Effect.Effect<Option.Option<R2ObjectBody>, StorageError>

  /**
   * Get object metadata without downloading the body
   */
  readonly head: (key: string) => Effect.Effect<Option.Option<R2Object>, StorageError>

  /**
   * Put an object
   */
  readonly put: (
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptions
  ) => Effect.Effect<R2Object, StorageError>

  /**
   * Delete an object
   */
  readonly delete: (key: string) => Effect.Effect<void, StorageError>

  /**
   * Delete multiple objects
   */
  readonly deleteMany: (keys: string[]) => Effect.Effect<void, StorageError>

  /**
   * List objects
   */
  readonly list: (options?: R2ListOptions) => Effect.Effect<
    { objects: R2Object[]; truncated: boolean; cursor?: string },
    StorageError
  >

  /**
   * Check if an object exists
   */
  readonly exists: (key: string) => Effect.Effect<boolean, StorageError>

  /**
   * Get object as text
   */
  readonly getText: (key: string) => Effect.Effect<Option.Option<string>, StorageError>

  /**
   * Get object as JSON with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, StorageError, R>

  /**
   * Put JSON object
   */
  readonly putJson: <A>(
    key: string,
    value: A,
    options?: Omit<R2PutOptions, "httpMetadata">
  ) => Effect.Effect<R2Object, StorageError>
}

/**
 * Storage Service Interface
 *
 * Provides access to multiple R2 buckets with type-safe binding selection.
 */
export interface StorageService {
  /**
   * Get operations for a specific R2 bucket
   *
   * @param binding - Type-safe binding name (only R2Bucket bindings shown)
   * @returns Operations scoped to that bucket
   *
   * @example
   * ```typescript
   * const storage = yield* Storage
   * const uploads = storage.from("UPLOADS_BUCKET")
   * const file = yield* uploads.get("documents/report.pdf")
   * ```
   */
  readonly from: (binding: R2BindingName) => StorageOperations
}

/**
 * Storage Service Tag
 */
export class Storage extends Context.Tag("Storage")<Storage, StorageService>() {}

/**
 * Create Storage operations for a specific bucket
 */
const makeStorageOperations = (
  r2: R2Bucket,
  bindingName: string
): StorageOperations => {
  const ops: StorageOperations = {
    get: (key: string) =>
      Effect.tryPromise({
        try: () => r2.get(key),
        catch: (error) =>
          new StorageError({
            operation: "get",
            key,
            message: `[${bindingName}] Failed to get object "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.map(Option.fromNullable),
        Effect.withSpan("storage.get", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    head: (key: string) =>
      Effect.tryPromise({
        try: () => r2.head(key),
        catch: (error) =>
          new StorageError({
            operation: "head",
            key,
            message: `[${bindingName}] Failed to get metadata "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.map(Option.fromNullable),
        Effect.withSpan("storage.head", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    put: (key, value, options) =>
      Effect.tryPromise({
        try: () => r2.put(key, value, options),
        catch: (error) =>
          new StorageError({
            operation: "put",
            key,
            message: `[${bindingName}] Failed to put object "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.put", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    delete: (key) =>
      Effect.tryPromise({
        try: () => r2.delete(key),
        catch: (error) =>
          new StorageError({
            operation: "delete",
            key,
            message: `[${bindingName}] Failed to delete object "${key}"`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.delete", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    deleteMany: (keys) =>
      Effect.tryPromise({
        try: () => r2.delete(keys),
        catch: (error) =>
          new StorageError({
            operation: "deleteMany",
            message: `[${bindingName}] Failed to delete ${keys.length} objects`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.deleteMany", {
          attributes: { "storage.binding": bindingName, "storage.count": keys.length },
        })
      ),

    list: (options) =>
      Effect.tryPromise({
        try: () => r2.list(options),
        catch: (error) =>
          new StorageError({
            operation: "list",
            message: `[${bindingName}] Failed to list objects`,
            cause: error,
          }),
      }).pipe(
        Effect.withSpan("storage.list", {
          attributes: { "storage.binding": bindingName },
        })
      ),

    exists: (key) =>
      ops.head(key).pipe(Effect.map(Option.isSome)),

    getText: (key) =>
      ops.get(key).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: (obj) =>
              Effect.tryPromise({
                try: () => obj.text(),
                catch: (error) =>
                  new StorageError({
                    operation: "getText",
                    key,
                    message: `[${bindingName}] Failed to read text from "${key}"`,
                    cause: error,
                  }),
              }).pipe(Effect.map(Option.some)),
          })
        ),
        Effect.withSpan("storage.getText", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
      ops.getText(key).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<A>()),
            onSome: (text) =>
              Effect.gen(function* () {
                const parsed = yield* Effect.try({
                  try: () => JSON.parse(text) as unknown,
                  catch: (error) =>
                    new StorageError({
                      operation: "getJson",
                      key,
                      message: `[${bindingName}] Invalid JSON in "${key}"`,
                      cause: error,
                    }),
                })

                const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
                  Effect.mapError(
                    (parseError) =>
                      new StorageError({
                        operation: "getJson",
                        key,
                        message: `[${bindingName}] Schema validation failed`,
                        cause: parseError,
                      })
                  )
                )

                return Option.some(decoded)
              }),
          })
        ),
        Effect.withSpan("storage.getJson", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),

    putJson: <A>(key: string, value: A, options?: Omit<R2PutOptions, "httpMetadata">) =>
      Effect.gen(function* () {
        const json = JSON.stringify(value)
        return yield* ops.put(key, json, {
          ...options,
          httpMetadata: { contentType: "application/json" },
        })
      }).pipe(
        Effect.withSpan("storage.putJson", {
          attributes: { "storage.binding": bindingName, "storage.key": key },
        })
      ),
  }

  return ops
}

/**
 * Live Storage Service Implementation
 */
export const StorageLive = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    // Cache operations per binding to avoid recreating
    const operationsCache = new Map<R2BindingName, StorageOperations>()

    const service: StorageService = {
      from: (binding: R2BindingName) => {
        const cached = operationsCache.get(binding)
        if (cached) return cached

        const bucket = env[binding] as R2Bucket
        const ops = makeStorageOperations(bucket, binding)
        operationsCache.set(binding, ops)
        return ops
      },
    }

    return service
  })
)

// ---------------------------------------------------------------------------
// Legacy Exports (for backwards compatibility during migration)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use Storage.from(binding) instead
 */
export { Storage as ObjectStorage }

/**
 * @deprecated Use StorageLive instead
 */
export const ObjectStorageDefault = StorageLive

/**
 * @deprecated Use StorageService instead
 */
export type ObjectStorageService = StorageService
