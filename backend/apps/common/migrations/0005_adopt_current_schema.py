"""Adopt Drizzle-created objects into Django's migration state.

Database operations are intentionally empty. Run ``schema_preflight --adopt``
against the existing database first; it records the historical migrations only
after proving that every expected table, column, constraint, and index exists.
"""

import uuid

from django.db import migrations, models
import apps.common.indexes


class Migration(migrations.Migration):
    dependencies = [("common", "0004_appsetting_userlimit")]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterModelOptions(name="user", options={"db_table": "users"}),
                migrations.AlterModelOptions(name="activitylog", options={"db_table": "activity_logs"}),
                migrations.AlterModelOptions(name="appsetting", options={"db_table": "settings"}),
                migrations.AlterModelOptions(name="userlimit", options={"db_table": "user_limits"}),
                migrations.CreateModel(
                    name="LoginAttempt",
                    fields=[
                        ("id", models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                        ("identifier", models.TextField()),
                        ("created_at", models.BigIntegerField()),
                    ],
                    options={"db_table": "login_attempts"},
                ),
                migrations.AddIndex(
                    model_name="loginattempt",
                    index=apps.common.indexes.PostgresIndex(fields=["identifier", "created_at"], name="login_attempts_identifier_created_idx"),
                ),
                migrations.AddIndex(
                    model_name="activitylog",
                    index=models.Index(fields=["created_at"], name="activity_logs_created_at_idx"),
                ),
            ],
        )
    ]
