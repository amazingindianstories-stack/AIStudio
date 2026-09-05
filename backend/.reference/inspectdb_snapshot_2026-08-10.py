# NOT imported anywhere — raw `manage.py inspectdb` output against the live
# Railway Postgres, kept as a starting point for per-domain model ports
# (tasks #3-#8). Each domain task should copy the relevant classes into a
# real app's models.py, not import this file directly.
#
# This is an auto-generated Django model module.
# You'll have to do the following manually to clean this up:
#   * Rearrange models' order
#   * Make sure each model has one field with primary_key=True
#   * Make sure each ForeignKey and OneToOneField has `on_delete` set to the desired behavior
#   * Remove `managed = False` lines if you wish to allow Django to create, modify, and delete the table
# Feel free to rename the models, but don't rename db_table values or field names.
from django.db import models


class ActivityLogs(models.Model):
    id = models.UUIDField(primary_key=True)
    user_id = models.UUIDField(blank=True, null=True)
    action = models.TextField()
    detail = models.JSONField(blank=True, null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'activity_logs'


class AgentConversationMessages(models.Model):
    id = models.UUIDField(primary_key=True)
    conversation_id = models.UUIDField()
    role = models.TextField()
    content = models.TextField()
    tool_trace = models.JSONField(blank=True, null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'agent_conversation_messages'


class AgentConversations(models.Model):
    id = models.UUIDField(primary_key=True)
    project_id = models.UUIDField()
    name = models.TextField()
    kind = models.TextField()
    created_by = models.UUIDField(blank=True, null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    agent_kind = models.TextField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = 'agent_conversations'


class Assets(models.Model):
    id = models.UUIDField(primary_key=True)
    kind = models.TextField()
    name = models.TextField()
    slug = models.TextField()
    description = models.TextField(blank=True, null=True)
    images = models.JSONField()
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'assets'


class CanvasBoards(models.Model):
    id = models.UUIDField(primary_key=True)
    project_id = models.UUIDField()
    name = models.TextField()
    data = models.JSONField()
    created_by = models.UUIDField(blank=True, null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'canvas_boards'


class Folders(models.Model):
    id = models.UUIDField(primary_key=True)
    project_id = models.UUIDField()
    name = models.TextField()
    created_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'folders'


class Generations(models.Model):
    id = models.UUIDField(primary_key=True)
    kind = models.TextField()
    status = models.TextField()
    prompt = models.TextField()
    model = models.TextField()
    aspect_ratio = models.TextField()
    resolution = models.TextField(blank=True, null=True)
    duration = models.IntegerField(blank=True, null=True)
    url = models.TextField(blank=True, null=True)
    poster = models.TextField(blank=True, null=True)
    error = models.TextField(blank=True, null=True)
    moderation_blocked = models.BooleanField(blank=True, null=True)
    reference_images = models.JSONField(blank=True, null=True)
    project_id = models.UUIDField(blank=True, null=True)
    folder_id = models.UUIDField(blank=True, null=True)
    user_id = models.UUIDField(blank=True, null=True)
    cost_cents = models.IntegerField()
    task_id = models.TextField(blank=True, null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    is_favorite = models.BooleanField()
    favorited_at = models.BigIntegerField(blank=True, null=True)
    generate_audio = models.BooleanField(blank=True, null=True)
    reference_videos = models.JSONField(blank=True, null=True)
    video_task_mode = models.TextField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = 'generations'


class Pricing(models.Model):
    model = models.TextField(primary_key=True)
    unit_cost_cents = models.IntegerField()
    unit = models.TextField()
    notes = models.TextField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = 'pricing'


class Projects(models.Model):
    id = models.UUIDField(primary_key=True)
    name = models.TextField()
    brief = models.TextField(blank=True, null=True)
    created_by = models.UUIDField(blank=True, null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'projects'


class Users(models.Model):
    id = models.UUIDField(primary_key=True)
    email = models.TextField(unique=True)
    password_hash = models.TextField()
    password_salt = models.TextField()
    name = models.TextField()
    role = models.TextField()
    color = models.TextField(blank=True, null=True)
    is_active = models.BooleanField()
    created_at = models.BigIntegerField()
    avatar_url = models.TextField(blank=True, null=True)
    auth_version = models.IntegerField()

    class Meta:
        managed = False
        db_table = 'users'
