from django.db import models

class User(models.Model):
    id = models.UUIDField(primary_key=True)
    email = models.TextField()
    name = models.TextField()
    role = models.TextField()
    color = models.TextField(null=True)
    avatar_url = models.TextField(null=True)
    is_active = models.BooleanField()
    auth_version = models.IntegerField()

    class Meta:
        managed = False
        db_table = 'users'
