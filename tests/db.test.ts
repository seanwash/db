import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  connectionFromEnvironment,
  containsVariable,
  parseDatabaseUrl,
  targetLaunchValue,
} from "../src/connection.ts";
import type { Context } from "../src/types.ts";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(repository, "src/main.ts");

test("builds an encoded PostgreSQL URL", () => {
  const values = new Map([
    ["DB_CONNECTION", "pgsql"],
    ["DB_HOST", "localhost"],
    ["DB_PORT", "5433"],
    ["DB_DATABASE", "sample database"],
    ["DB_USERNAME", "sample user"],
    ["DB_PASSWORD", "p@ssword"],
  ]);
  const context = contextAt("/tmp/project");

  const target = connectionFromEnvironment(values, "/tmp", context);

  assert.equal(
    targetLaunchValue(target, "sample"),
    "postgresql://sample%20user:p%40ssword@localhost:5433/sample%20database?name=sample&env=local",
  );
});

test("redacts passwords and query strings", () => {
  const url = parseDatabaseUrl(
    "postgresql://user:secret@localhost/app?token=also-secret",
  );

  assert.equal(url.redacted, "postgresql://user:••••@localhost/app");
});

test("preserves existing client metadata", () => {
  const target = {
    kind: "url" as const,
    url: parseDatabaseUrl(
      "postgresql://localhost/app?sslmode=disable&name=existing",
    ),
  };

  assert.equal(
    targetLaunchValue(target, "ignored"),
    "postgresql://localhost/app?sslmode=disable&name=existing&env=local",
  );
});

test("resolves relative SQLite paths", () => {
  const values = new Map([
    ["DB_CONNECTION", "sqlite"],
    ["DB_DATABASE", "storage/database.sqlite"],
  ]);

  const target = connectionFromEnvironment(
    values,
    "/tmp/project",
    contextAt("/tmp/project"),
  );

  assert.deepEqual(target, {
    kind: "sqlite",
    path: "/tmp/project/storage/database.sqlite",
  });
});

test("recognizes only complete unresolved variables", () => {
  assert.equal(containsVariable("$DATABASE_HOST"), true);
  assert.equal(containsVariable("${DATABASE_HOST}"), true);
  assert.equal(containsVariable("costs $5"), false);
  assert.equal(containsVariable("${DATABASE_HOST:-localhost}"), false);
});

test("resolves a parent environment and redacts credentials", (t) => {
  const root = project(t);
  mkdirSync(join(root, "apps/backend"), { recursive: true });
  writeFileSync(
    join(root, ".env"),
    "DATABASE_URL=postgresql://user:secret@localhost/app?token=also-secret\n",
  );

  const result = run(join(root, "apps/backend"), ["--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Database: postgresql://user:••••@localhost/app\nSource:   ${realpathSync(root)}/.env\n`,
  );
  assert.doesNotMatch(result.stdout, /secret/);
  assert.doesNotMatch(result.stdout, /also-secret/);
});

test("test profile prefers the test URL", (t) => {
  const root = project(t);
  writeFileSync(join(root, ".env"), "DATABASE_URL=postgresql://localhost/default\n");
  writeFileSync(
    join(root, ".env.test"),
    "TEST_DATABASE_URL=postgresql://localhost/testing\n",
  );

  const result = run(root, ["test", "--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Database: postgresql:\/\/localhost\/testing\n/);
  assert.match(
    result.stdout,
    new RegExp(`Source:   ${escapeRegex(realpathSync(root))}/\\.env, ${escapeRegex(realpathSync(root))}/\\.env\\.test\\n`),
  );
});

test("shell values override environment files", (t) => {
  const root = project(t);
  writeFileSync(
    join(root, ".env"),
    "DB_CONNECTION=pgsql\nDB_HOST=file-host\nDB_DATABASE=file-db\nDB_USERNAME=file-user\n",
  );

  const result = run(root, ["--dry-run"], {
    DB_HOST: "shell-host",
    DB_DATABASE: "shell-db",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /postgresql:\/\/file-user@shell-host:5432\/shell-db/);
});

test("opens an explicit SQLite file with TablePro in dry-run mode", (t) => {
  const root = temporaryDirectory(t);
  const sqlite = join(root, "database.sqlite");

  const result = run(root, [sqlite, "--client", "tablepro", "--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Database: SQLite ${sqlite}\nSource:   command line\n`,
  );
});

test("reports multiple discovered environments", (t) => {
  const root = project(t);
  mkdirSync(join(root, "apps/one"), { recursive: true });
  mkdirSync(join(root, "apps/two"), { recursive: true });
  writeFileSync(join(root, "apps/one/.env"), "DB_CONNECTION=sqlite\n");
  writeFileSync(join(root, "apps/two/.env"), "DB_CONNECTION=sqlite\n");

  const result = run(root, ["--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple database environments were found/);
  assert.match(result.stderr, /apps\/one\/\.env/);
  assert.match(result.stderr, /apps\/two\/\.env/);
});

test("parses quotes, comments, exports, expansion, and BOM", (t) => {
  const root = project(t);
  writeFileSync(
    join(root, ".env"),
    "\uFEFFexport DB_CONNECTION=pgsql\nDB_HOST=localhost\nBASE=sample\nDB_DATABASE=\"$BASE database\"\nDB_USERNAME='sample user'\nDB_PASSWORD=secret # hidden\n",
  );

  const result = run(root, ["--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /postgresql:\/\/sample%20user:••••@localhost:5432\/sample%20database/,
  );
});

test("rejects multiple test environment files", (t) => {
  const root = project(t);
  writeFileSync(join(root, ".env.test"), "DB_CONNECTION=sqlite\n");
  writeFileSync(join(root, ".env.testing"), "DB_CONNECTION=sqlite\n");

  const result = run(root, ["test", "--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple test environment files found/);
});

test("resolves from the shell when no files exist", (t) => {
  const root = temporaryDirectory(t);

  const result = run(root, ["--dry-run"], {
    DATABASE_URL: "mysql://user:secret@localhost/app",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Database: mysql:\/\/user:••••@localhost\/app\n/);
  assert.match(result.stdout, /Source:   shell environment\n/);
});

test("expands values across environment layers", (t) => {
  const root = project(t);
  writeFileSync(
    join(root, ".env"),
    "DB_CONNECTION=pgsql\nDB_HOST=localhost\nDB_USERNAME=user\nBASE=sample\n",
  );
  writeFileSync(join(root, ".env.local"), "DB_DATABASE=\"$BASE database\"\n");

  const result = run(root, ["--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /postgresql:\/\/user@localhost:5432\/sample%20database/);
});

test("dotenv errors do not echo secret values", (t) => {
  const root = project(t);
  writeFileSync(join(root, ".env"), "DB_PASSWORD=should-not-appear invalid\n");

  const result = run(root, ["--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not parse environment configuration/);
  assert.doesNotMatch(result.stderr, /should-not-appear/);
});

test("rejects out-of-range ports", (t) => {
  const root = project(t);
  writeFileSync(
    join(root, ".env"),
    "DB_CONNECTION=mysql\nDB_HOST=localhost\nDB_PORT=70000\nDB_DATABASE=app\nDB_USERNAME=root\n",
  );

  const result = run(root, ["--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DB_PORT must be between 1 and 65535/);
});

test("prints help and version", (t) => {
  const root = temporaryDirectory(t);
  const help = run(root, ["--help"]);
  const version = run(root, ["--version"]);

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: db \[TARGET\] \[OPTIONS\]/);
  assert.equal(version.stdout, "db 0.1.0\n");
});

function contextAt(cwd: string): Context {
  return { cwd, variables: new Map() };
}

function project(t: test.TestContext): string {
  const root = temporaryDirectory(t);
  mkdirSync(join(root, ".git"));
  return root;
}

function temporaryDirectory(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "db-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return realpathSync(root);
}

function run(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const binary = process.env.DB_TEST_BINARY;
  const command = binary === undefined ? process.execPath : join(repository, binary);
  const commandArgs = binary === undefined ? [entrypoint, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
