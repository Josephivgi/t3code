import {
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
} from "../auth/http.ts";
import * as PluginStore from "./PluginStore.ts";

type PluginHttpError =
  | EnvironmentRequestInvalidError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError;

const failPluginStore = (
  cause: PluginStore.PluginStoreError,
): Effect.Effect<never, PluginHttpError> => {
  if (cause.reason === "not_found") return failEnvironmentNotFound("plugin_not_found");
  if (cause.reason === "invalid") return failEnvironmentInvalidRequest("plugin_invalid");
  return failEnvironmentInternal("plugin_store_failed", cause);
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "plugins",
  Effect.fnUntraced(function* (handlers) {
    const store = yield* PluginStore.PluginStore;

    return handlers
      .handle(
        "list",
        Effect.fn("environment.plugins.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* store.list.pipe(Effect.catch(failPluginStore));
        }),
      )
      .handle(
        "file",
        Effect.fn("environment.plugins.file")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* store
            .readFile(args.params.id, args.query.path)
            .pipe(Effect.catch(failPluginStore));
        }),
      )
      .handle(
        "state",
        Effect.fn("environment.plugins.state")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* store
            .setState(args.params.id, args.payload)
            .pipe(Effect.catch(failPluginStore));
        }),
      )
      .handle(
        "call",
        Effect.fn("environment.plugins.call")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* store
            .call(args.params.id, args.payload.method, args.payload.args)
            .pipe(Effect.catch(failPluginStore));
        }),
      )
      .handle(
        "bootStart",
        Effect.fn("environment.plugins.bootStart")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* store
            .clientBootStart(args.payload.ids, args.payload.build)
            .pipe(Effect.catch(failPluginStore));
          return {};
        }),
      )
      .handle(
        "bootOk",
        Effect.fn("environment.plugins.bootOk")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* store.clientBootOk(args.payload.ids).pipe(Effect.catch(failPluginStore));
          return {};
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.plugins.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* store.remove(args.params.id).pipe(Effect.catch(failPluginStore));
          return { deleted: true as const };
        }),
      );
  }),
);
