from django.db import migrations, models

from apps.common.db_flags import TEST_MANAGED


class Migration(migrations.Migration):
    dependencies = [("common", "0003_activitylog")]

    operations = [
        migrations.CreateModel(
            name="AppSetting",
            fields=[
                ("key", models.TextField(primary_key=True, serialize=False)),
                ("value", models.TextField()),
                ("updated_at", models.BigIntegerField()),
            ],
            options={"db_table": "settings", "managed": TEST_MANAGED},
        ),
        migrations.CreateModel(
            name="UserLimit",
            fields=[
                ("pk", models.CompositePrimaryKey("user_id", "key", blank=True, primary_key=True, serialize=False)),
                ("user_id", models.UUIDField()),
                ("key", models.TextField()),
                ("value", models.TextField()),
                ("updated_at", models.BigIntegerField()),
            ],
            options={"db_table": "user_limits", "managed": TEST_MANAGED},
        ),
    ]
