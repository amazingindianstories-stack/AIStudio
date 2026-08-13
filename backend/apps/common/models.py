import uuid

from django.db import models

from .db_flags import TEST_MANAGED


class User(models.Model):
    """Mirrors src/lib/schema.js `users` — managed = TEST_MANAGED (normally
    False; Drizzle remains the schema owner in production, see
    apps/common/db_flags.py). password_hash/password_salt added for the
    admin dashboard's user-management routes (task #12) — scrypt params
    must stay identical to password.py/password.js, verified interop
    2026-08-10."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    email = models.TextField(unique=True)
    password_hash = models.TextField(db_column="password_hash", default="")
    password_salt = models.TextField(db_column="password_salt", default="")
    name = models.TextField()
    role = models.TextField(default="user")
    color = models.TextField(null=True)
    avatar_url = models.TextField(db_column="avatar_url", null=True)
    is_active = models.BooleanField(db_column="is_active", default=True)
    auth_version = models.IntegerField(db_column="auth_version", default=0)
    created_at = models.BigIntegerField(db_column="created_at")

    class Meta:
        managed = TEST_MANAGED
        db_table = "users"

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def is_anonymous(self) -> bool:
        return False


class ActivityLog(models.Model):
    """Mirrors src/lib/schema.js `activity_logs` — append-only admin audit
    trail. Lives alongside User (rather than in apps.admin_dashboard, which
    only reads it) because apps.common.activity.log_activity is called from
    every domain app (auth, generation, history, projects, assets, admin) —
    it's cross-cutting infrastructure, the same category as session auth."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(null=True)
    action = models.TextField()
    detail = models.JSONField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = TEST_MANAGED
        db_table = "activity_logs"
