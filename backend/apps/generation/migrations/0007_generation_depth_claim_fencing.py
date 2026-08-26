from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("generation", "0006_generation_flag_reason_generation_flagged_and_more")]

    operations = [
        migrations.AddField(
            model_name="generation",
            name="depth_claim_id",
            field=models.UUIDField(null=True),
        ),
        migrations.AddField(
            model_name="generation",
            name="depth_claim_worker_id",
            field=models.TextField(null=True),
        ),
        migrations.AddField(
            model_name="generation",
            name="depth_reap_attempts",
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name="depthworker",
            name="current_claim_id",
            field=models.UUIDField(null=True),
        ),
    ]
