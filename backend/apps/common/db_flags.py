"""Shared flag for the managed=False test-DB problem: models that mirror an
existing Drizzle-owned table (see apps/core/models.py's docstring) skip DDL
in production, but Django's test runner creates a *fresh, empty* database
per run — so with managed=False nothing ever creates "projects", "assets",
etc. there, and every test touching one of those tables fails with
"relation ... does not exist", not a real bug.

DJANGO_TEST_MANAGED=1 flips every mirrored model to managed=True for that
process only, so `manage.py test` can create real tables in the throwaway
test database. Never set this outside a test run — it must stay unset in
production, where these tables already exist under Drizzle and Django must
never issue DDL against them.
"""

import os

TEST_MANAGED = os.environ.get("DJANGO_TEST_MANAGED") == "1"
