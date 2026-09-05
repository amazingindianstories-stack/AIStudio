import uuid

from django.db import models

from .indexes import PostgresIndex

class User(models.Model):
    """Application user; password fields retain Next-compatible scrypt data."""

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
        db_table = "activity_logs"
        indexes = [models.Index(fields=["created_at"], name="activity_logs_created_at_idx")]


class AppSetting(models.Model):
    key = models.TextField(primary_key=True)
    value = models.TextField()
    updated_at = models.BigIntegerField()

    class Meta:
        db_table = "settings"


class UserLimit(models.Model):
    pk = models.CompositePrimaryKey("user_id", "key")
    user_id = models.UUIDField()
    key = models.TextField()
    value = models.TextField()
    updated_at = models.BigIntegerField()

    class Meta:
        db_table = "user_limits"


class LoginAttempt(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    identifier = models.TextField()
    created_at = models.BigIntegerField()

    class Meta:
        db_table = "login_attempts"
        indexes = [
            PostgresIndex(
                fields=["identifier", "created_at"],
                name="login_attempts_identifier_created_idx",
            )
        ]
