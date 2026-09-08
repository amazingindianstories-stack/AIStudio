from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("canvas", "0001_initial")]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterModelOptions(name="canvasboard", options={"db_table": "canvas_boards"}),
                migrations.AddIndex(
                    model_name="canvasboard",
                    index=models.Index(fields=["project_id"], name="canvas_boards_project_id_idx"),
                )
            ],
        )
    ]
