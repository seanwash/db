import { extname, isAbsolute, join, resolve } from "node:path";

import { DbError } from "./errors.ts";
import type { Context } from "./types.ts";

export type DatabaseUrl = {
  href: string;
  redacted: string;
};

export type ExplicitTarget =
  | { kind: "url"; url: DatabaseUrl }
  | { kind: "sqlite"; path: string };

export type ConnectionTarget = ExplicitTarget;

export function parseExplicitTarget(input: string): ExplicitTarget {
  if (input.includes("://")) {
    return { kind: "url", url: parseDatabaseUrl(input) };
  }

  const extension = extname(input).toLowerCase();
  if (extension === ".db" || extension === ".sqlite" || extension === ".sqlite3") {
    return { kind: "sqlite", path: input };
  }

  throw new DbError("the argument must be a connection URL, SQLite file, or 'test'");
}

export function resolveExplicitTarget(
  target: ExplicitTarget,
  context: Context,
): ConnectionTarget {
  if (target.kind === "url") {
    return target;
  }

  return {
    kind: "sqlite",
    path: absolutePath(expandHome(target.path, context), context.cwd),
  };
}

export function connectionFromEnvironment(
  values: Map<string, string>,
  baseDirectory: string,
  context: Context,
): ConnectionTarget {
  const driver = required(values, "DB_CONNECTION").toLowerCase();
  const database = required(values, "DB_DATABASE");

  if (driver === "sqlite") {
    const path = expandHome(database, context);
    return {
      kind: "sqlite",
      path: absolutePath(path, baseDirectory),
    };
  }

  let scheme: string;
  let defaultPort: number;
  if (driver === "pgsql" || driver === "postgres" || driver === "postgresql") {
    scheme = "postgresql";
    defaultPort = 5432;
  } else if (driver === "mysql" || driver === "mariadb") {
    scheme = "mysql";
    defaultPort = 3306;
  } else {
    throw new DbError(
      `DB_CONNECTION=${driver} is not supported yet; provide DATABASE_URL instead`,
    );
  }

  const host = required(values, "DB_HOST");
  const username = required(values, "DB_USERNAME");
  const password = values.get("DB_PASSWORD") || undefined;
  if (password !== undefined && containsVariable(password)) {
    throw new DbError("DB_PASSWORD contains an unresolved environment variable");
  }

  const portValue = values.get("DB_PORT");
  const port = portValue === undefined || portValue === "" ? defaultPort : parsePort(portValue);
  const credentials = password === undefined
    ? encodeURIComponent(username)
    : `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  return {
    kind: "url",
    url: parseDatabaseUrl(
      `${scheme}://${credentials}@${address}:${port}/${encodeURIComponent(database)}`,
    ),
  };
}

export function parseDatabaseUrl(input: string): DatabaseUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DbError("the connection URL is invalid");
  }

  const schemeEnd = input.indexOf("://");
  if (schemeEnd < 1) {
    throw new DbError("the connection URL is invalid");
  }

  const scheme = input.slice(0, schemeEnd).toLowerCase();
  const authority = urlAuthority(url.href);
  const host = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (scheme !== "sqlite" && host === "") {
    throw new DbError("the connection URL is missing a host");
  }

  return {
    href: url.href,
    redacted: redactUrl(url.href),
  };
}

export function targetDescription(target: ConnectionTarget): string {
  return target.kind === "url" ? target.url.redacted : `SQLite ${target.path}`;
}

export function targetLaunchValue(target: ConnectionTarget, name: string): string {
  if (target.kind === "sqlite") {
    return target.path;
  }

  const url = new URL(target.url.href);
  if (!url.searchParams.has("name")) {
    url.searchParams.append("name", name);
  }
  if (!url.searchParams.has("env")) {
    url.searchParams.append("env", "local");
  }
  return url.href;
}

export function expandHome(path: string, context: Context): string {
  const home = context.variables.get("HOME");
  if (home === undefined) {
    return path;
  }
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }
  return path;
}

export function absolutePath(path: string, base: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

export function containsVariable(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    if (value.charAt(index) !== "$") {
      index += 1;
      continue;
    }

    const next = value.charAt(index + 1);
    if (next === "{") {
      const first = value.charAt(index + 2);
      if (!isVariableStart(first)) {
        index += 1;
        continue;
      }
      let end = index + 3;
      while (end < value.length && isVariableCharacter(value.charAt(end))) {
        end += 1;
      }
      if (value.charAt(end) === "}") {
        return true;
      }
    } else if (isVariableStart(next)) {
      return true;
    }
    index += 1;
  }
  return false;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value === "") {
    throw new DbError(`${key} is required to construct the database connection`);
  }
  if (containsVariable(value)) {
    throw new DbError(`${key} contains an unresolved environment variable`);
  }
  return value;
}

function parsePort(input: string): number {
  if (input === "") {
    throw new DbError("DB_PORT must be a number");
  }
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code < 48 || code > 57) {
      throw new DbError("DB_PORT must be a number");
    }
  }
  const port = Number(input);
  if (port < 1 || port > 65535) {
    throw new DbError("DB_PORT must be between 1 and 65535");
  }
  return port;
}

function redactUrl(href: string): string {
  const schemeEnd = href.indexOf("://");
  const authorityStart = schemeEnd + 3;
  const authorityEnd = findAuthorityEnd(href, authorityStart);
  const authority = href.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf("@");

  let redactedAuthority = authority;
  if (at >= 0) {
    const credentials = authority.slice(0, at);
    const address = authority.slice(at + 1);
    const colon = credentials.indexOf(":");
    redactedAuthority = colon >= 0
      ? `${credentials.slice(0, colon)}:••••@${address}`
      : `${credentials}@${address}`;
  }

  const pathEnd = findPathEnd(href, authorityEnd);
  return `${href.slice(0, authorityStart)}${redactedAuthority}${href.slice(authorityEnd, pathEnd)}`;
}

function urlAuthority(href: string): string {
  const start = href.indexOf("://") + 3;
  return href.slice(start, findAuthorityEnd(href, start));
}

function findAuthorityEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const character = value.charAt(index);
    if (character === "/" || character === "?" || character === "#") {
      return index;
    }
    index += 1;
  }
  return value.length;
}

function findPathEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const character = value.charAt(index);
    if (character === "?" || character === "#") {
      return index;
    }
    index += 1;
  }
  return value.length;
}

function isVariableStart(character: string): boolean {
  if (character === "_") {
    return true;
  }
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isVariableCharacter(character: string): boolean {
  if (isVariableStart(character)) {
    return true;
  }
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}
