# db

`db` opens the current project's local database in TablePlus. It discovers common dotenv files, resolves PostgreSQL, MySQL, MariaDB, and SQLite connections, and redacts credentials in terminal output.

```text
current directory
      │
      ▼
discover project + dotenv files
      │
      ▼
resolve and validate connection
      │
      ▼
open TablePlus
```

## Usage

```console
db
db test
db --env path/to/.env
db postgresql://user:password@localhost/database
db path/to/database.sqlite
db --dry-run
```

Use `--name` to override the connection name shown in TablePlus. Use `--dry-run` to inspect the resolved connection without opening the app.

The default profile checks these files in order:

```text
.env
.env.development
.env.local
.env.development.local
```

The `test` profile additionally reads either `.env.test` or `.env.testing`, and recognizes `TABLEPLUS_TEST_URL` and `TEST_DATABASE_URL`.

## Development

The CLI requires Python 3.9 or newer and has no runtime dependencies.

```console
python3 -m unittest discover -s tests
```

To install the command from a checkout:

```console
uv tool install --editable .
```

On this machine, `~/.local/bin/db` is linked directly to `src/db_cli.py`, so edits in the repository are immediately reflected in the command.
