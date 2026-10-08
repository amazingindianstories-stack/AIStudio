from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('authentication','0002_loginattempt')]
    operations = [
        migrations.AddField(model_name='user',name='password_hash',field=models.TextField()),
        migrations.AddField(model_name='user',name='password_salt',field=models.TextField()),
        migrations.AddField(model_name='user',name='created_at',field=models.BigIntegerField()),
    ]
