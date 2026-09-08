"""Tests for the DATABASE_URL-must-be-Postgres system check (checks.py)."""

import os
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.common.checks import postgres_engine_check


class PostgresEngineCheckTests(SimpleTestCase):
    def test_warns_when_engine_is_not_postgres(self):
        # This suite itself is commonly run with DJANGO_ALLOW_NON_POSTGRES_TESTS
        # set (see CLAUDE.md) precisely so its own noise doesn't distract from
        # the actual test results — so this test must not inherit that from
        # the real environment, or it would falsely pass for the wrong reason.
        with patch(
            "django.conf.settings.DATABASES",
            {"default": {"ENGINE": "django.db.backends.sqlite3"}},
        ), patch.dict(os.environ, {}, clear=True):
            result = postgres_engine_check(None)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].id, "common.W001")
        self.assertIn("PostgreSQL", result[0].msg)

    def test_silent_when_engine_is_postgres(self):
        with patch(
            "django.conf.settings.DATABASES",
            {"default": {"ENGINE": "django.db.backends.postgresql"}},
        ):
            result = postgres_engine_check(None)
        self.assertEqual(result, [])

    def test_silenced_by_explicit_opt_out_env_var(self):
        with patch(
            "django.conf.settings.DATABASES",
            {"default": {"ENGINE": "django.db.backends.sqlite3"}},
        ), patch.dict(os.environ, {"DJANGO_ALLOW_NON_POSTGRES_TESTS": "1"}):
            result = postgres_engine_check(None)
        self.assertEqual(result, [])
