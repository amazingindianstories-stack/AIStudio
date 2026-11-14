from django.contrib.postgres.functions import RandomUUID
from django.db import models
from apps.authentication.models import User

PROJECT_ROLES = ('owner', 'co_owner', 'editor', 'commenter', 'viewer')
PROJECT_ACCESS_MODES = ('all', 'users', 'admin')


class Project(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    name = models.TextField()
    brief = models.TextField(null=True)
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    # Who may see the project at all: everyone, only the users in ProjectAccessUser (and its creator), or admins.
    access = models.TextField(default='all')

    class Meta:
        managed = True
        db_table = 'projects'
        constraints = [models.CheckConstraint(condition=models.Q(access__in=PROJECT_ACCESS_MODES), name='projects_access_check')]


class ProjectAccessUser(models.Model):
    """A user allowed into a project whose access mode is 'users'."""
    pk = models.CompositePrimaryKey('project_id', 'user_id')
    project = models.ForeignKey(Project, on_delete=models.CASCADE, db_index=False, related_name='access_users')
    user = models.ForeignKey(User, on_delete=models.CASCADE, db_index=False)
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'project_access_users'
        indexes = [models.Index(fields=['user'], name='project_access_users_user_idx')]


class ProjectMember(models.Model):
    """A project role applies to every board in the project; apps.canvas.access combines it with board roles."""
    pk = models.CompositePrimaryKey('project_id', 'user_id')
    project = models.ForeignKey(Project, on_delete=models.CASCADE, db_index=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, db_index=False)
    role = models.TextField()
    added_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'project_members'
        indexes = [models.Index(fields=['user'], name='project_members_user_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(role__in=PROJECT_ROLES), name='project_members_role_check')]
