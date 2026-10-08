from apps.common.indexes import PostgreSQLIndex
from django.db import models

class User(models.Model):
    id = models.UUIDField(primary_key=True)
    email = models.TextField(unique=True)
    password_hash = models.TextField()
    password_salt = models.TextField()
    created_at = models.BigIntegerField()
    name = models.TextField()
    role = models.TextField()
    color = models.TextField(null=True)
    avatar_url = models.TextField(null=True)
    is_active = models.BooleanField()
    auth_version = models.IntegerField()

    class Meta:
        managed = False
        db_table = 'users'

class LoginAttempt(models.Model):
    id = models.UUIDField(primary_key=True)
    identifier = models.TextField()
    created_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'login_attempts'
        indexes = [
            PostgreSQLIndex(models.F('identifier').asc(nulls_last=True), models.F('created_at').asc(nulls_last=True), name='login_attempts_identifier_created_idx'),
        ]
