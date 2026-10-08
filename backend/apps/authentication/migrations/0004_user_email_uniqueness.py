from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('authentication', '0003_user_credentials')]
    operations = [
        migrations.AlterField(model_name='user', name='email', field=models.TextField(unique=True)),
    ]
