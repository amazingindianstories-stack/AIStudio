from django.contrib.postgres.functions import RandomUUID
from django.db import models
from apps.authentication.models import User

PROJECT_ROLES = ('owner', 'co_owner', 'editor', 'commenter', 'viewer')


class Project(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    name = models.TextField()
    brief = models.TextField(null=True)
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = True
        db_table = 'projects'


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
