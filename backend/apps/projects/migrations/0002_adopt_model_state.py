"""Normalize restored migration options without touching the live tables."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterModelOptions(name="folder", options={"db_table": "folders"}),
                migrations.AlterModelOptions(name="project", options={"db_table": "projects"}),
            ],
        )
    ]
