from django.db import migrations, models
from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    dependencies = [('exports', '0001_initial')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AddIndex(model_name='mediaexport', index=PostgreSQLIndex(models.F('user_id').asc(nulls_last=True), models.F('created_at').desc(nulls_last=True), name='media_exports_user_created_idx')),
                migrations.AddIndex(model_name='mediaexport', index=PostgreSQLIndex(models.F('status').asc(nulls_last=True), models.F('lease_until').asc(nulls_last=True), models.F('created_at').asc(nulls_last=True), name='media_exports_worker_due_idx')),
                migrations.AddIndex(model_name='mediaexportitem', index=PostgreSQLIndex(models.F('export').asc(nulls_last=True), models.F('position').asc(nulls_last=True), name='media_export_items_order_idx')),
            ],
        ),
    ]
