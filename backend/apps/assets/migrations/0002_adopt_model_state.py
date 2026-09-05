"""Normalize restored migration options without touching the live table."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("assets", "0001_initial")]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterModelOptions(name="asset", options={"db_table": "assets"}),
            ],
        )
    ]
