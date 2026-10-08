from django.db import migrations, models
from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    dependencies = [('authentication', '0004_user_email_uniqueness')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AddIndex(model_name='loginattempt', index=PostgreSQLIndex(models.F('identifier').asc(nulls_last=True), models.F('created_at').asc(nulls_last=True), name='login_attempts_identifier_created_idx')),
            ],
        ),
    ]
