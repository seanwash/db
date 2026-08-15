# db

`db` opens the current project's local database in TablePlus or TablePro. It discovers common dotenv files, resolves PostgreSQL, MySQL, MariaDB, and SQLite connections, and redacts credentials in terminal output.

```text
current directory
      │
      ▼
discover project + dotenv files
      │
      ▼
resolve and validate a client-neutral connection
      │
      ▼
selected client adapter
  ├── TablePlus
  └── TablePro
```

## Usage

```console
db
db test
db --env path/to/.env
db postgresql://user:password@localhost/database
db path/to/database.sqlite
db --client tablepro
db --dry-run
```

TablePlus is the default client. Use `--client tablepro` to open the connection in TablePro.

Use `--name` to override the connection name shown in the selected client. Use `--dry-run` to inspect the resolved connection without opening the app.

The default profile checks these files in order:

```text
.env
.env.development
.env.local
.env.development.local
```

The `test` profile additionally reads either `.env.test` or `.env.testing`, and recognizes `TABLEPLUS_TEST_URL` and `TEST_DATABASE_URL`. `TABLEPLUS_URL` and `TABLEPLUS_TEST_URL` remain supported for compatibility.

## Installation

Building requires Node.js 22.18 or newer and the Xcode Command Line Tools. The installed `db` executable has no Node.js or npm dependency.

```console
npm install
npm run build
mkdir -p ~/.local/bin
install -m 755 dist/db ~/.local/bin/db
```

Ensure `~/.local/bin` is on your `PATH`. Repeat the build and install commands after changing the source.

## How it is built

The implementation is ordinary TypeScript using supported `node:*` APIs. ScriptC compiles it into a native macOS executable:

```text
src/main.ts
    │
    │ ScriptC
    ▼
dist/db
    └── standalone native executable
```

## Development

```console
npm run check
npm test
npm run coverage
npm run build
npm run test:native
```

`npm run coverage` must report 100% static compilation. `npm run verify` runs the complete sequence.
