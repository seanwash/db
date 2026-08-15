#!/usr/bin/env python3

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


ENV_FILE_NAMES = (
    ".env",
    ".env.development",
    ".env.local",
    ".env.development.local",
)
TEST_ENV_FILE_NAMES = (".env.test", ".env.testing")
IGNORED_DIRECTORIES = {
    ".git",
    ".next",
    ".output",
    ".turbo",
    "build",
    "dist",
    "node_modules",
    "storage",
    "vendor",
}
DRIVER_SCHEMES = {
    "pgsql": ("postgresql", 5432),
    "postgres": ("postgresql", 5432),
    "postgresql": ("postgresql", 5432),
    "mysql": ("mysql", 3306),
    "mariadb": ("mysql", 3306),
}
VARIABLE_PATTERN = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
URL_KEYS = ("TABLEPLUS_URL", "DATABASE_URL", "DB_URL")
DB_KEYS = (
    "DB_CONNECTION",
    "DB_HOST",
    "DB_PORT",
    "DB_DATABASE",
    "DB_USERNAME",
    "DB_PASSWORD",
)


class DbOpenError(Exception):
    pass


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="db",
        description="Open the current project's local database in TablePlus.",
    )
    parser.add_argument(
        "target",
        nargs="?",
        help="A connection URL, SQLite file, or the profile name 'test'.",
    )
    parser.add_argument(
        "--env",
        type=Path,
        metavar="FILE",
        help="Read one specific dotenv file instead of discovering one.",
    )
    parser.add_argument("--name", help="Override the TablePlus connection name.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the resolved connection with credentials redacted.",
    )
    return parser.parse_args(argv)


def project_root(start):
    for directory in (start, *start.parents):
        if (directory / ".git").exists():
            return directory
    return start


def environment_names(profile):
    if profile == "test":
        return (*ENV_FILE_NAMES, *TEST_ENV_FILE_NAMES)
    return ENV_FILE_NAMES


def environment_directories(root, names, max_depth=4):
    matches = set()
    for current, directories, files in os.walk(root):
        current_path = Path(current)
        depth = len(current_path.relative_to(root).parts)
        directories[:] = [
            directory
            for directory in directories
            if directory not in IGNORED_DIRECTORIES and depth < max_depth
        ]
        if any(name in files for name in names):
            matches.add(current_path)
    return sorted(matches)


def discover_environment_directory(start, profile):
    root = project_root(start)
    names = environment_names(profile)
    for directory in (start, *start.parents):
        if any((directory / name).is_file() for name in names):
            return directory
        if directory == root:
            break
    matches = environment_directories(root, names)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        choices = "\n".join(f"  db --env {path / '.env'}" for path in matches)
        raise DbOpenError(
            "Multiple database environments were found. Choose one explicitly:\n"
            f"{choices}"
        )
    return None


def strip_unquoted_comment(value):
    match = re.search(r"\s+#", value)
    return value[: match.start()].rstrip() if match else value.strip()


def decode_double_quoted(value, path, line_number):
    output = []
    escaped = False
    escapes = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", '"': '"'}
    for index, character in enumerate(value[1:], start=1):
        if escaped:
            output.append(escapes.get(character, character))
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if character == '"':
            remainder = value[index + 1 :].strip()
            if remainder and not remainder.startswith("#"):
                raise DbOpenError(f"Invalid value in {path}:{line_number}")
            return "".join(output)
        output.append(character)
    raise DbOpenError(f"Unclosed quote in {path}:{line_number}")


def parse_value(value, path, line_number):
    value = value.strip()
    if not value:
        return "", True
    if value.startswith("'"):
        closing = value.find("'", 1)
        if closing == -1:
            raise DbOpenError(f"Unclosed quote in {path}:{line_number}")
        remainder = value[closing + 1 :].strip()
        if remainder and not remainder.startswith("#"):
            raise DbOpenError(f"Invalid value in {path}:{line_number}")
        return value[1:closing], False
    if value.startswith('"'):
        return decode_double_quoted(value, path, line_number), True
    return strip_unquoted_comment(value), True


def expand_variables(value, variables):
    def replace(match):
        key = match.group(1) or match.group(2)
        return variables.get(key, match.group(0))

    return VARIABLE_PATTERN.sub(replace, value)


def read_dotenv(path, existing):
    values = {}
    text = path.read_text(encoding="utf-8-sig")
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise DbOpenError(f"Invalid dotenv entry in {path}:{line_number}")
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not KEY_PATTERN.fullmatch(key):
            raise DbOpenError(f"Invalid dotenv key in {path}:{line_number}")
        value, expandable = parse_value(raw_value, path, line_number)
        variables = {**os.environ, **existing, **values}
        values[key] = expand_variables(value, variables) if expandable else value
    return values


def environment_files(directory, profile):
    if directory is None:
        return []
    files = [directory / name for name in ENV_FILE_NAMES if (directory / name).is_file()]
    if profile == "test":
        test_files = [
            directory / name
            for name in TEST_ENV_FILE_NAMES
            if (directory / name).is_file()
        ]
        if len(test_files) > 1:
            joined = ", ".join(str(path) for path in test_files)
            raise DbOpenError(f"Multiple test environment files found: {joined}")
        files.extend(test_files)
    return files


def load_environment(paths):
    values = {}
    for path in paths:
        values.update(read_dotenv(path, values))
    for key in (*URL_KEYS, "TABLEPLUS_TEST_URL", "TEST_DATABASE_URL", *DB_KEYS):
        if key in os.environ:
            values[key] = os.environ[key]
    return values


def require_value(values, key):
    value = values.get(key)
    if value is None or value == "":
        raise DbOpenError(f"{key} is required to construct the database connection")
    if VARIABLE_PATTERN.search(value):
        raise DbOpenError(f"{key} contains an unresolved environment variable")
    return value


def connection_from_fields(values, base_directory):
    driver = require_value(values, "DB_CONNECTION").lower()
    database = require_value(values, "DB_DATABASE")
    if driver == "sqlite":
        path = Path(database).expanduser()
        if not path.is_absolute():
            path = base_directory / path
        return path.resolve()
    if driver not in DRIVER_SCHEMES:
        raise DbOpenError(
            f"DB_CONNECTION={driver} is not supported yet; provide TABLEPLUS_URL instead"
        )
    scheme, default_port = DRIVER_SCHEMES[driver]
    host = require_value(values, "DB_HOST")
    username = require_value(values, "DB_USERNAME")
    password = values.get("DB_PASSWORD", "")
    port_text = values.get("DB_PORT") or str(default_port)
    try:
        port = int(port_text)
    except ValueError as error:
        raise DbOpenError("DB_PORT must be a number") from error
    if not 1 <= port <= 65535:
        raise DbOpenError("DB_PORT must be between 1 and 65535")
    host_text = f"[{host}]" if ":" in host and not host.startswith("[") else host
    credentials = quote(username, safe="")
    if password:
        credentials += f":{quote(password, safe='')}"
    netloc = f"{credentials}@{host_text}:{port}"
    return urlunsplit((scheme, netloc, f"/{quote(database, safe='')}", "", ""))


def validate_url(url):
    parsed = urlsplit(url)
    if not parsed.scheme:
        raise DbOpenError("The connection URL is missing a scheme")
    if parsed.scheme != "sqlite" and not parsed.netloc:
        raise DbOpenError("The connection URL is missing a host")
    return url


def add_tableplus_metadata(url, name):
    parsed = urlsplit(url)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    keys = {key for key, _ in query}
    if "name" not in keys:
        query.append(("name", name))
    if "env" not in keys:
        query.append(("env", "local"))
    return urlunsplit((*parsed[:3], urlencode(query), parsed.fragment))


def redact_url(url):
    parsed = urlsplit(url)
    netloc = parsed.netloc
    if "@" in netloc:
        credentials, address = netloc.rsplit("@", 1)
        if ":" in credentials:
            username, _ = credentials.split(":", 1)
            credentials = f"{username}:••••"
        netloc = f"{credentials}@{address}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


def describe(target):
    if isinstance(target, Path):
        return f"SQLite {target}"
    parsed = urlsplit(target)
    return f"{parsed.scheme}://{redact_url(target).split('://', 1)[1]}"


def resolve(args, cwd):
    if args.target and args.target != "test":
        if "://" in args.target:
            target = validate_url(args.target)
            name = args.name or cwd.name
            return add_tableplus_metadata(target, name), ["command line"]
        sqlite_path = Path(args.target).expanduser()
        if sqlite_path.suffix.lower() in {".db", ".sqlite", ".sqlite3"}:
            return sqlite_path.resolve(), ["command line"]
        raise DbOpenError("The argument must be a connection URL, SQLite file, or 'test'")

    profile = "test" if args.target == "test" else "default"
    if args.env:
        path = args.env.expanduser().resolve()
        if not path.is_file():
            raise DbOpenError(f"Environment file not found: {path}")
        paths = [path]
        environment_directory = path.parent
    else:
        environment_directory = discover_environment_directory(cwd, profile)
        paths = environment_files(environment_directory, profile)

    values = load_environment(paths)
    if profile == "test":
        test_url = values.get("TABLEPLUS_TEST_URL") or values.get("TEST_DATABASE_URL")
        has_test_file = any(path.name in TEST_ENV_FILE_NAMES for path in paths)
        if test_url:
            target = validate_url(test_url)
        elif has_test_file:
            target = connection_from_fields(values, environment_directory or cwd)
        else:
            raise DbOpenError(
                "No test database configuration found; add .env.testing, .env.test, "
                "or TEST_DATABASE_URL"
            )
    else:
        url = next((values[key] for key in URL_KEYS if values.get(key)), None)
        target = (
            validate_url(url)
            if url
            else connection_from_fields(values, environment_directory or cwd)
        )

    if isinstance(target, Path):
        return target, [str(path) for path in paths] or ["shell environment"]
    root = project_root(cwd)
    name = args.name or root.name
    return add_tableplus_metadata(target, name), [str(path) for path in paths] or [
        "shell environment"
    ]


def main(argv=None):
    try:
        args = parse_args(argv)
        target, sources = resolve(args, Path.cwd().resolve())
        print(f"Database: {describe(target)}")
        print(f"Source:   {', '.join(sources)}")
        if args.dry_run:
            return 0
        subprocess.run(["open", "-a", "TablePlus", str(target)], check=True)
        return 0
    except DbOpenError as error:
        print(f"db: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"db: TablePlus could not be opened ({error.returncode})", file=sys.stderr)
        return error.returncode


if __name__ == "__main__":
    raise SystemExit(main())
