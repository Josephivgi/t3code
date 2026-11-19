import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
// @effect-diagnostics nodeBuiltinImport:off - bounded whole-file reads keep the
// asset route simple; sizes are capped at resolveAsset time.
import * as NodeFS from "node:fs";

import * as Mime from "effect/http/Mime";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as Option from "effect/Option";

import {
  annotateEnvironmentRequest,
  authenticateMediaRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as PluginManager from "./PluginManager.ts";

const PLUGIN_ASSET_ROUTE_PREFIX = "/api/plugin-assets";

const failPluginError = Effect.fn("environment.plugins.failError")(function* (
  cause: PluginManager.PluginError,
) {
  switch (cause._tag) {
    case "PluginRefusedError":
      return yield* failEnvironmentInvalidRequest("invalid_plugin", cause.problem);
    case "PluginNotFoundError":
      return yield* failEnvironmentNotFound("plugin_not_found");
    case "PluginRevertUnavailableError":
      return yield* failEnvironmentInvalidRequest("plugin_revert_unavailable");
    default:
      return yield* failEnvironmentInternal("plugin_operation_failed", cause);
  }
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "plugins",
  Effect.fnUntraced(function* (handlers) {
    const plugins = yield* PluginManager.PluginManagerService;

    return handlers
      .handle(
        "list",
        Effect.fn("environment.plugins.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* plugins.list;
        }),
      )
      .handle(
        "install",
        Effect.fn("environment.plugins.install")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const plugin = yield* plugins.install(args.payload).pipe(Effect.catch(failPluginError));
          return { ok: true as const, plugin };
        }),
      )
      .handle(
        "enable",
        Effect.fn("environment.plugins.enable")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const plugin = yield* plugins
            .setEnabled(args.params.pluginId, true)
            .pipe(Effect.catch(failPluginError));
          return { ok: true as const, plugin };
        }),
      )
      .handle(
        "disable",
        Effect.fn("environment.plugins.disable")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const plugin = yield* plugins
            .setEnabled(args.params.pluginId, false)
            .pipe(Effect.catch(failPluginError));
          return { ok: true as const, plugin };
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.plugins.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* plugins.remove(args.params.pluginId).pipe(Effect.catch(failPluginError));
          return { ok: true as const };
        }),
      )
      .handle(
        "revert",
        Effect.fn("environment.plugins.revert")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const result = yield* plugins
            .revert(args.payload.pluginId)
            .pipe(Effect.catch(failPluginError));
          return {
            ok: true as const,
            reverted: result.reverted,
            ...(result.plugin === undefined ? {} : { plugin: result.plugin }),
          };
        }),
      );
  }),
);

/**
 * Serves files from installed plugin directories for `<img>`, `<link>` and
 * `<iframe>` contributions. HTML answers with the strict sandbox CSP the app
 * already uses for untrusted content, so panel scripts cannot reach the app.
 */
export const layerPluginAssetsRoute = HttpRouter.add(
  "GET",
  `${PLUGIN_ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const suffix = url.value.pathname.slice(`${PLUGIN_ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const pluginId = decodeURIComponent(suffix.slice(0, separatorIndex));
    const assetPath = decodeURIComponent(suffix.slice(separatorIndex + 1));

    const plugins = yield* PluginManager.PluginManagerService;
    const asset = yield* plugins.resolveAsset(pluginId, assetPath);
    if (asset === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    // resolveAsset bounds files to 512 KiB, so a whole-file read is safe here.
    const bytes = yield* Effect.tryPromise({
      try: () => NodeFS.promises.readFile(asset.filePath),
      catch: () => null,
    });
    if (bytes === null || bytes.byteLength === 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const isHtml = /\.(?:html?|htm)$/i.test(assetPath);
    return HttpServerResponse.uint8Array(new Uint8Array(bytes), {
      contentType: Option.getOrElse(Mime.getType(asset.filePath), () => "application/octet-stream"),
      headers: {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        // Plugin HTML (panels) runs in an opaque origin: no storage, cookies or app access.
        ...(isHtml
          ? { "content-security-policy": "sandbox allow-scripts allow-forms allow-popups" }
          : {}),
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
