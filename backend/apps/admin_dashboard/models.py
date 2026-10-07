from django.db import models

class AppSetting(models.Model):
    key = models.TextField(primary_key=True)
    value = models.TextField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'settings'

class UserLimit(models.Model):
    pk = models.CompositePrimaryKey('user_id', 'key')
    user_id = models.UUIDField()
    key = models.TextField()
    value = models.TextField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'user_limits'
