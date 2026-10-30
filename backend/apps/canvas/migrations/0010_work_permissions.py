"""Grant the existing runtime roles access to work records and in-app delivery."""
from django.db import migrations
from django.contrib.postgres.indexes import GinIndex


class Migration(migrations.Migration):
    dependencies = [('canvas', '0009_work_records')]
    operations = [migrations.SeparateDatabaseAndState(state_operations=[migrations.AddIndex(
        model_name="workrecord", index=GinIndex(fields=["cells"], name="work_records_cells_gin_idx", opclasses=["jsonb_path_ops"]))],
        database_operations=[migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_work_tables, canvas_work_records, canvas_work_relations, canvas_work_history, board_notifications, board_notification_preferences TO %I', r);
            EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE canvas_work_relations_id_seq TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON canvas_work_tables, canvas_work_records, canvas_work_relations, canvas_work_history, board_notifications, board_notification_preferences TO goal4_green_history_writer;
    END IF;
END $$;
CREATE INDEX work_records_cells_gin_idx ON canvas_work_records USING gin (cells jsonb_path_ops);
""", "DROP INDEX IF EXISTS work_records_cells_gin_idx;")])]
