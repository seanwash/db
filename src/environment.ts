import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  absolutePath,
  connectionFromEnvironment,
  expandHome,
  parseDatabaseUrl,
  type ConnectionTarget,
} from "./connection.ts";
import { loadDotenvFiles } from "./dotenv.ts";
import { DbError } from "./errors.ts";
import type { Context, Profile } from "./types.ts";

const DEFAULT_FILES = [
  ".env",
  ".env.development",
  ".env.local",
  ".env.development.local",
];
const TEST_FILES = [".env.test", ".env.testing"];
const URL_KEYS = ["TABLEPLUS_URL", "DATABASE_URL", "DB_URL"];
const SHELL_OVERRIDES = [
  "TABLEPLUS_URL",
  "DATABASE_URL",
  "DB_URL",
  "TABLEPLUS_TEST_URL",
  "TEST_DATABASE_URL",
  "DB_CONNECTION",
  "DB_HOST",
  "DB_PORT",
  "DB_DATABASE",
  "DB_USERNAME",
  "DB_PASSWORD",
  "HOME",
];
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".output",
  ".turbo",
  "build",
  "dist",
  "node_modules",
  "storage",
  "vendor",
]);

export type EnvironmentConnection = {
  target: ConnectionTarget;
  root: string;
  sources: string[];
};

export function captureContext(): Context {
  const variables = new Map<string, string>();
  const environment = process.env;
  for (const key of Object.keys(environment)) {
    const value = environment[key];
    if (value !== undefined) {
      variables.set(key, value);
    }
  }
  return { cwd: process.cwd(), variables };
}

export function resolveEnvironment(
  context: Context,
  profile: Profile,
  explicitFile?: string,
): EnvironmentConnection {
  const root = projectRoot(context.cwd);
  let directory: string | undefined;
  let paths: string[];

  if (explicitFile !== undefined) {
    const path = absolutePath(expandHome(explicitFile, context), context.cwd);
    if (!isFile(path)) {
      throw new DbError(`environment file not found: ${path}`);
    }
    directory = dirname(path);
    paths = [path];
  } else {
    directory = discoverEnvironmentDirectory(context.cwd, root, profile);
    paths = environmentFiles(directory, profile);
  }

  const values = loadDotenvFiles(paths, context.variables);
  for (const key of SHELL_OVERRIDES) {
    const value = context.variables.get(key);
    if (value !== undefined) {
      values.set(key, value);
    }
  }

  const target = resolveTarget(
    values,
    profile,
    paths,
    directory ?? context.cwd,
    context,
  );
  return { target, root, sources: paths };
}

export function projectRoot(start: string): string {
  let directory = start;
  while (true) {
    if (existsSync(join(directory, ".git"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return start;
    }
    directory = parent;
  }
}

function discoverEnvironmentDirectory(
  start: string,
  root: string,
  profile: Profile,
): string | undefined {
  const names = profile === "test" ? [...DEFAULT_FILES, ...TEST_FILES] : DEFAULT_FILES;
  let directory = start;
  while (true) {
    if (names.some((name) => isFile(join(directory, name)))) {
      return directory;
    }
    if (directory === root) {
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  const matches: string[] = [];
  try {
    collectEnvironmentDirectories(root, names, 0, matches);
  } catch (error) {
    if (error instanceof Error) {
      throw new DbError(`could not search for database environments: ${error.message}`);
    }
    throw error;
  }
  matches.sort();

  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }

  const choices = matches.map((path) => `  db --env ${join(path, ".env")}`).join("\n");
  throw new DbError(`multiple database environments were found. Choose one explicitly:\n${choices}`);
}

function collectEnvironmentDirectories(
  directory: string,
  names: string[],
  depth: number,
  matches: string[],
): void {
  if (names.some((name) => isFile(join(directory, name)))) {
    matches.push(directory);
  }
  if (depth === 4) {
    return;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    collectEnvironmentDirectories(join(directory, entry.name), names, depth + 1, matches);
  }
}

function environmentFiles(directory: string | undefined, profile: Profile): string[] {
  if (directory === undefined) {
    return [];
  }

  const paths = DEFAULT_FILES
    .map((name) => join(directory, name))
    .filter(isFile);
  if (profile === "test") {
    const testPaths = TEST_FILES
      .map((name) => join(directory, name))
      .filter(isFile);
    if (testPaths.length > 1) {
      throw new DbError(`multiple test environment files found: ${testPaths.join(", ")}`);
    }
    paths.push(...testPaths);
  }
  return paths;
}

function resolveTarget(
  values: Map<string, string>,
  profile: Profile,
  paths: string[],
  baseDirectory: string,
  context: Context,
): ConnectionTarget {
  if (profile === "test") {
    const testUrl = firstValue(values, ["TABLEPLUS_TEST_URL", "TEST_DATABASE_URL"]);
    if (testUrl !== undefined) {
      return { kind: "url", url: parseDatabaseUrl(testUrl) };
    }
    if (paths.some((path) => TEST_FILES.includes(basename(path)))) {
      return connectionFromEnvironment(values, baseDirectory, context);
    }
    throw new DbError(
      "no test database configuration found; add .env.testing, .env.test, or TEST_DATABASE_URL",
    );
  }

  const url = firstValue(values, URL_KEYS);
  if (url !== undefined) {
    return { kind: "url", url: parseDatabaseUrl(url) };
  }
  return connectionFromEnvironment(values, baseDirectory, context);
}

function firstValue(values: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}
