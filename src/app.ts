import { spawnSync } from "node:child_process";
import { basename } from "node:path";

import type { Invocation } from "./cli.ts";
import {
  resolveExplicitTarget,
  targetDescription,
  targetLaunchValue,
  type ConnectionTarget,
} from "./connection.ts";
import { DbError } from "./errors.ts";
import { resolveEnvironment } from "./environment.ts";
import type { Client, Context } from "./types.ts";

export type LaunchPlan = {
  client: Client;
  target: ConnectionTarget;
  name: string;
  sources: string[];
};

export function resolveInvocation(invocation: Invocation, context: Context): LaunchPlan {
  if (invocation.source.kind === "explicit") {
    return {
      client: invocation.client,
      target: resolveExplicitTarget(invocation.source.target, context),
      name: invocation.name ?? directoryName(context.cwd),
      sources: ["command line"],
    };
  }

  const connection = resolveEnvironment(
    context,
    invocation.source.profile,
    invocation.source.file,
  );
  return {
    client: invocation.client,
    target: connection.target,
    name: invocation.name ?? directoryName(connection.root),
    sources: connection.sources.length === 0 ? ["shell environment"] : connection.sources,
  };
}

export function planOutput(plan: LaunchPlan): string {
  return `Database: ${targetDescription(plan.target)}\nSource:   ${plan.sources.join(", ")}`;
}

export function openClient(plan: LaunchPlan): void {
  const appName = plan.client === "tableplus" ? "TablePlus" : "TablePro";
  const result = spawnSync(
    "/usr/bin/open",
    ["-a", appName, targetLaunchValue(plan.target, plan.name)],
    { stdio: "ignore" },
  );
  if (result.status !== 0) {
    throw new DbError(`${appName} could not be opened (${result.status})`);
  }
}

function directoryName(path: string): string {
  const name = basename(path);
  return name === "" ? path : name;
}
