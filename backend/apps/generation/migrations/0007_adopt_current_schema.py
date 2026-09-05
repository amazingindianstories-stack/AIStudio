"""State-only adoption of columns and indexes already created by Drizzle."""

from django.db import migrations, models
import apps.common.indexes


class Migration(migrations.Migration):
    dependencies = [("generation", "0006_generation_flag_reason_generation_flagged_and_more")]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterModelOptions(name="generation", options={"db_table": "generations"}),
                migrations.AlterModelOptions(name="pricing", options={"db_table": "pricing"}),
                migrations.AlterModelOptions(name="depthworker", options={"db_table": "depth_workers"}),
                migrations.AddField(model_name="generation", name="cost_basis", field=models.TextField(default="estimated")),
                migrations.AddField(model_name="generation", name="poll_error_count", field=models.IntegerField(default=0)),
                migrations.AddField(model_name="generation", name="last_poll_error_at", field=models.BigIntegerField(null=True)),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["created_at"], name="generations_created_at_idx")),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["status", "kind", "created_at"], name="generations_queue_idx")),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["project_id"], name="generations_project_id_idx")),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["folder_id"], name="generations_folder_id_idx")),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["user_id", "created_at"], name="generations_user_created_idx")),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["-created_at", "-id"], name="generations_created_keyset_idx")),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["project_id", "-created_at", "-id"], name="generations_project_keyset_idx")),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["folder_id", "-created_at", "-id"], name="generations_folder_keyset_idx")),
                migrations.AddIndex(model_name="generation", index=apps.common.indexes.PostgresIndex(fields=["-favorited_at", "-id"], name="generations_favorite_keyset_idx", condition=models.Q(is_favorite=True))),
                migrations.AddIndex(model_name="generation", index=models.Index(fields=["-flagged_at", "-id"], name="generations_flagged_keyset_idx", condition=models.Q(flagged=True))),
                migrations.AddIndex(
                    model_name="generation",
                    index=apps.common.indexes.PostgresIndex(
                        fields=["updated_at", "created_at", "id"],
                        name="generations_stale_video_poll_idx",
                        condition=models.Q(kind="video", status__in=["queued", "running"], task_id__isnull=False),
                    ),
                ),
            ],
        )
    ]
