from django.contrib.postgres.functions import RandomUUID
from apps.common.indexes import PostgreSQLIndex
from django.db import models

class User(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    email = models.TextField(unique=True)
    password_hash = models.TextField()
    password_salt = models.TextField()
    created_at = models.BigIntegerField()
    name = models.TextField()
    role = models.TextField(db_default='user')
    color = models.TextField(null=True)
    avatar_url = models.TextField(null=True)
    is_active = models.BooleanField(db_default=True)
    auth_version = models.IntegerField(db_default=0)

    class Meta:
        managed = True
        db_table = 'users'

class LoginAttempt(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    identifier = models.TextField()
    created_at = models.BigIntegerField()
    class Meta:
        managed = True
        db_table = 'login_attempts'
        indexes = [
            PostgreSQLIndex(models.F('identifier').asc(nulls_last=True), models.F('created_at').asc(nulls_last=True), name='login_attempts_identifier_created_idx'),
        ]
