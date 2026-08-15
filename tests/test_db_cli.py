import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import db_cli


class DotenvTests(unittest.TestCase):
    def test_reads_quotes_comments_and_variable_expansion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "BASE=database\n"
                "EXPANDED=prefix-$BASE\n"
                "LITERAL='$BASE'\n"
                'ESCAPED="first\\nsecond"\n'
                "COMMENTED=value # ignored\n",
                encoding="utf-8",
            )

            values = db_cli.read_dotenv(path, {})

        self.assertEqual(values["EXPANDED"], "prefix-database")
        self.assertEqual(values["LITERAL"], "$BASE")
        self.assertEqual(values["ESCAPED"], "first\nsecond")
        self.assertEqual(values["COMMENTED"], "value")

    def test_rejects_invalid_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("not-an-assignment\n", encoding="utf-8")

            with self.assertRaisesRegex(db_cli.DbOpenError, "Invalid dotenv entry"):
                db_cli.read_dotenv(path, {})


class ConnectionTests(unittest.TestCase):
    def test_builds_encoded_postgresql_url(self):
        values = {
            "DB_CONNECTION": "pgsql",
            "DB_HOST": "localhost",
            "DB_PORT": "5433",
            "DB_DATABASE": "sample database",
            "DB_USERNAME": "sample user",
            "DB_PASSWORD": "p@ssword",
        }

        url = db_cli.connection_from_fields(values, Path("/tmp"))

        self.assertEqual(
            url,
            "postgresql://sample%20user:p%40ssword@localhost:5433/sample%20database",
        )

    def test_resolves_relative_sqlite_path(self):
        values = {
            "DB_CONNECTION": "sqlite",
            "DB_DATABASE": "storage/database.sqlite",
        }

        path = db_cli.connection_from_fields(values, Path("/tmp/project"))

        self.assertEqual(path, Path("/tmp/project/storage/database.sqlite").resolve())

    def test_rejects_invalid_port(self):
        values = {
            "DB_CONNECTION": "mysql",
            "DB_HOST": "localhost",
            "DB_PORT": "70000",
            "DB_DATABASE": "app",
            "DB_USERNAME": "root",
        }

        with self.assertRaisesRegex(db_cli.DbOpenError, "between 1 and 65535"):
            db_cli.connection_from_fields(values, Path("/tmp"))

    def test_adds_tableplus_metadata_without_overwriting_query_values(self):
        url = db_cli.add_tableplus_metadata(
            "postgresql://localhost/app?sslmode=disable&name=existing",
            "ignored",
        )
        query = parse_qs(urlsplit(url).query)

        self.assertEqual(query["sslmode"], ["disable"])
        self.assertEqual(query["name"], ["existing"])
        self.assertEqual(query["env"], ["local"])

    def test_redacts_password_and_query_string(self):
        redacted = db_cli.redact_url(
            "postgresql://user:secret@localhost/app?token=also-secret"
        )

        self.assertEqual(redacted, "postgresql://user:••••@localhost/app")


class ResolutionTests(unittest.TestCase):
    def test_discovers_environment_from_project_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".git").mkdir()
            current = root / "apps" / "backend"
            current.mkdir(parents=True)
            env_path = root / ".env"
            env_path.write_text(
                "DATABASE_URL=postgresql://user:secret@localhost/app\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {}, clear=True):
                target, sources = db_cli.resolve(db_cli.parse_args([]), current)

        query = parse_qs(urlsplit(target).query)
        self.assertEqual(query["name"], [root.name])
        self.assertEqual(query["env"], ["local"])
        self.assertEqual(sources, [str(env_path)])

    def test_test_profile_prefers_test_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".git").mkdir()
            (root / ".env").write_text(
                "DATABASE_URL=postgresql://localhost/default\n",
                encoding="utf-8",
            )
            test_path = root / ".env.test"
            test_path.write_text(
                "TEST_DATABASE_URL=postgresql://localhost/testing\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {}, clear=True):
                target, sources = db_cli.resolve(db_cli.parse_args(["test"]), root)

        self.assertEqual(urlsplit(target).path, "/testing")
        self.assertEqual(sources, [str(root / ".env"), str(test_path)])

    def test_explicit_url_uses_current_directory_name(self):
        args = db_cli.parse_args(["postgresql://localhost/app"])

        target, sources = db_cli.resolve(args, Path("/tmp/example"))

        self.assertEqual(parse_qs(urlsplit(target).query)["name"], ["example"])
        self.assertEqual(sources, ["command line"])


if __name__ == "__main__":
    unittest.main()
