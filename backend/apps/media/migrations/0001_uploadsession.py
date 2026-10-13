import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [migrations.CreateModel(
        name='UploadSession',
        fields=[
            ('id', models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
            ('actor_id', models.UUIDField()),
            ('key', models.TextField(unique=True)),
            ('purpose', models.CharField(max_length=64)),
            ('content_type', models.CharField(max_length=100)),
            ('byte_size', models.BigIntegerField()),
            ('filename', models.CharField(max_length=255, default='')),
            ('sha256', models.CharField(max_length=64, default='')),
            ('request_key', models.CharField(max_length=128, default='')),
            ('session_uri', models.TextField(default='')),
            ('state', models.CharField(max_length=16, default='uploading')),
            ('created_at', models.DateTimeField(auto_now_add=True)),
            ('expires_at', models.DateTimeField()),
            ('finalized_at', models.DateTimeField(null=True)),
        ],
        options={
            'db_table': 'upload_sessions',
            'indexes': [models.Index(fields=['actor_id', 'state', 'expires_at'], name='upload_actor_state_expiry_idx')],
            'constraints': [
                models.CheckConstraint(condition=models.Q(byte_size__gt=0), name='upload_positive_bytes'),
                models.UniqueConstraint(fields=['actor_id', 'request_key'], condition=~models.Q(request_key=''), name='upload_actor_request_unique'),
            ],
        },
    )]
