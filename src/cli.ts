import { parseExplicitTarget, type ExplicitTarget } from "./connection.ts";
import { DbError } from "./errors.ts";
import type { Client, Profile } from "./types.ts";

export type Invocation = {
  source:
    | { kind: "explicit"; target: ExplicitTarget }
    | { kind: "environment"; profile: Profile; file?: string };
  client: Client;
  name?: string;
  dryRun: boolean;
};

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; invocation: Invocation };

export function parseCli(args: string[]): Command {
  let target: string | undefined;
  let envFile: string | undefined;
  let client: Client = "tableplus";
  let name: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      return { kind: "help" };
    }
    if (argument === "--version" || argument === "-V") {
      return { kind: "version" };
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--env") {
      envFile = optionValue(args, index, "--env");
      index += 1;
      continue;
    }
    if (argument === "--client") {
      const value = optionValue(args, index, "--client");
      if (value !== "tableplus" && value !== "tablepro") {
        throw new DbError("--client must be 'tableplus' or 'tablepro'");
      }
      client = value;
      index += 1;
      continue;
    }
    if (argument === "--name") {
      name = optionValue(args, index, "--name");
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new DbError(`unexpected argument '${argument}'`);
    }
    if (target !== undefined) {
      throw new DbError(`unexpected argument '${argument}'`);
    }
    target = argument;
  }

  if (target !== undefined && target !== "test") {
    if (envFile !== undefined) {
      throw new DbError("--env cannot be used with an explicit connection URL or SQLite file");
    }
    return {
      kind: "run",
      invocation: {
        source: { kind: "explicit", target: parseExplicitTarget(target) },
        client,
        name,
        dryRun,
      },
    };
  }

  return {
    kind: "run",
    invocation: {
      source: {
        kind: "environment",
        profile: target === "test" ? "test" : "default",
        file: envFile,
      },
      client,
      name,
      dryRun,
    },
  };
}

export function helpText(): string {
  return `Open the current project's local database in a database client.

Usage: db [TARGET] [OPTIONS]

Arguments:
  [TARGET]  A connection URL, SQLite file, or the profile name 'test'

Options:
      --env <FILE>        Read one specific dotenv file instead of discovering one
      --client <CLIENT>   Database client to open [default: tableplus]
      --name <NAME>       Override the connection name
      --dry-run           Show the resolved connection with credentials redacted
  -h, --help              Print help
  -V, --version           Print version`;
}

function optionValue(args: string[], index: number, option: string): string {
  if (index + 1 >= args.length) {
    throw new DbError(`${option} requires a value`);
  }
  return args[index + 1];
}
