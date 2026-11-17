import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { callPlugin } from "../../plugins/pluginHost";

interface JTokensHarness {
  readonly name: string;
  readonly tokens: number;
  readonly costUsd: number;
  readonly requests: number;
}
interface JTokensModel {
  readonly name: string;
  readonly harness: string;
  readonly tokens: number;
  readonly costUsd: number;
}
interface JTokensDay {
  readonly day: string;
  readonly tokens: number;
  readonly costUsd: number;
}
interface JTokensUsageData {
  readonly totals: {
    readonly tokens: number;
    readonly costUsd: number;
    readonly requests: number;
    readonly files: number;
  };
  readonly harnesses: ReadonlyArray<JTokensHarness>;
  readonly models: ReadonlyArray<JTokensModel>;
  readonly days: ReadonlyArray<JTokensDay>;
  readonly pricesChecked: string;
  readonly scanMs: number;
}

type LoadState =
  | { readonly phase: "ready"; readonly key: number; readonly data: JTokensUsageData }
  | { readonly phase: "error"; readonly key: number; readonly message: string };

function isUsageData(value: unknown): value is JTokensUsageData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const totals = v.totals as Record<string, unknown> | null | undefined;
  return (
    typeof totals === "object" &&
    totals !== null &&
    typeof totals.tokens === "number" &&
    typeof totals.costUsd === "number" &&
    typeof totals.requests === "number" &&
    Array.isArray(v.harnesses) &&
    Array.isArray(v.models) &&
    Array.isArray(v.days)
  );
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });

/** JTokens' own numbers (Claude Code, Codex, OpenCode, Pi and Droid logs), read by the JTokens plugin. */
export function JTokensUsage(props: {
  readonly reloadKey: number;
  readonly onLoadingChange: (loading: boolean) => void;
}) {
  const { reloadKey, onLoadingChange } = props;
  const [state, setState] = useState<LoadState | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the plugin's JSON when the tab opens or the user presses Refresh
  useEffect(() => {
    let cancelled = false;
    onLoadingChange(true);
    callPlugin("jtokens", "usage", { force: reloadKey > 0 })
      .then((result) => {
        if (cancelled) return;
        if (isUsageData(result)) setState({ phase: "ready", key: reloadKey, data: result });
        else
          setState({
            phase: "error",
            key: reloadKey,
            message: "The JTokens plugin returned data in an unexpected shape.",
          });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            key: reloadKey,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      })
      .finally(() => {
        if (!cancelled) onLoadingChange(false);
      });
    return () => {
      cancelled = true;
      onLoadingChange(false);
    };
  }, [reloadKey, onLoadingChange]);

  const launch = () => {
    setLaunchMessage(null);
    callPlugin("jtokens", "launch", {}).then(
      () => setLaunchMessage("JTokens is starting."),
      (cause: unknown) => setLaunchMessage(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  if (state === null || state.key !== reloadKey) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Spinner size="sm" aria-hidden="true" />
        Reading your logs. The first read can take several seconds.
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="space-y-2 py-12 text-sm text-muted-foreground">
        <p>Could not read JTokens: {state.message}</p>
      </div>
    );
  }

  const { data } = state;
  const maxHarness = Math.max(1, ...data.harnesses.map((harness) => harness.tokens));
  const maxDay = Math.max(1, ...data.days.map((day) => day.tokens));
  return (
    <div className="space-y-8" data-jtokens-usage>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-3xl font-semibold tracking-tight">
            {compact.format(data.totals.tokens)}
          </p>
          <p className="text-xs text-muted-foreground">
            tokens · {money.format(data.totals.costUsd)} at API prices ·{" "}
            {compact.format(data.totals.requests)} requests
          </p>
        </div>
        <div className="flex items-center gap-3">
          {launchMessage ? (
            <span className="text-xs text-muted-foreground">{launchMessage}</span>
          ) : null}
          <Button size="sm" variant="outline" onClick={launch}>
            Open JTokens
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <h2 data-section-title className="text-sm font-medium text-foreground">
          By tool
        </h2>
        <ul className="space-y-2">
          {data.harnesses.map((harness) => (
            <li
              key={harness.name}
              className="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-center gap-3 text-sm"
            >
              <span className="truncate">{harness.name}</span>
              <span className="h-2 rounded-full bg-muted">
                <span
                  className="block h-2 rounded-full bg-primary"
                  style={{ width: `${(harness.tokens / maxHarness) * 100}%` }}
                />
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {compact.format(harness.tokens)} · {money.format(harness.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 data-section-title className="text-sm font-medium text-foreground">
          Last 30 days
        </h2>
        <div
          className="flex h-24 items-end gap-0.5"
          role="img"
          aria-label="Tokens per day for the last 30 days"
        >
          {data.days.map((day) => (
            <span
              key={day.day}
              aria-label={`${day.day}: ${compact.format(day.tokens)} tokens, ${money.format(day.costUsd)}`}
              className="min-w-0 flex-1 rounded-t bg-primary/70"
              style={{ height: `${Math.max(2, (day.tokens / maxDay) * 100)}%` }}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 data-section-title className="text-sm font-medium text-foreground">
          Top models
        </h2>
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">Model</th>
              <th className="py-1 text-left font-normal">Tool</th>
              <th className="py-1 text-right font-normal">Cost</th>
              <th className="py-1 text-right font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((model) => (
              <tr key={`${model.harness}:${model.name}`} className="border-t border-border/50">
                <td className="py-1.5 pe-3">{model.name}</td>
                <td className="py-1.5 pe-3 text-muted-foreground">{model.harness}</td>
                <td className="py-1.5 text-right tabular-nums">{money.format(model.costUsd)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {compact.format(model.tokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-muted-foreground">
        From JTokens: {data.totals.files.toLocaleString("en")} log files, read in{" "}
        {(data.scanMs / 1000).toFixed(1)} s. API list prices checked {data.pricesChecked}.
      </p>
    </div>
  );
}
