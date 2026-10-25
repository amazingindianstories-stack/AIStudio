"""Reserve names once per draft lineage without changing any existing name."""
import django.db.models.deletion
from django.db import migrations, models
from django.db.models.functions import Lower


BACKFILL = """
INSERT INTO generation_name_owners (id, permanent_name, legacy_name_duplicate)
SELECT id, permanent_name, legacy_name_duplicate FROM generations WHERE permanent_name IS NOT NULL;
UPDATE generations SET name_owner_id=id WHERE permanent_name IS NOT NULL;
"""

PROTECT = r"""
CREATE OR REPLACE FUNCTION protect_generation_permanent_name() RETURNS trigger AS $$
DECLARE
    owner_name TEXT;
    owner_duplicate INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.permanent_name IS NOT NULL THEN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.permanent_name IS DISTINCT FROM OLD.permanent_name OR
           NEW.name_owner_id IS DISTINCT FROM OLD.name_owner_id OR
           NEW.legacy_name_duplicate IS DISTINCT FROM OLD.legacy_name_duplicate THEN
            RAISE EXCEPTION 'A generation permanent name and owner cannot change' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.name_owner_id = NEW.id THEN RETURN NEW; END IF;
        IF NEW.source_generation_id IS DISTINCT FROM OLD.source_generation_id OR
           NEW.draft_task_id IS DISTINCT FROM OLD.draft_task_id OR
           NEW.kind IS DISTINCT FROM OLD.kind OR NEW.model IS DISTINCT FROM OLD.model OR
           NEW.draft_mode IS DISTINCT FROM OLD.draft_mode THEN
            RAISE EXCEPTION 'A shared name lineage cannot change' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.permanent_name IS NULL THEN
        IF NEW.name_owner_id IS NOT NULL THEN
            RAISE EXCEPTION 'A name owner requires a permanent name' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    NEW.name_owner_id := COALESCE(NEW.name_owner_id, NEW.id);
    IF NEW.name_owner_id = NEW.id THEN
        IF NEW.legacy_name_duplicate <> 0 THEN
            RAISE EXCEPTION 'New names cannot use a legacy duplicate ordinal' USING ERRCODE = 'check_violation';
        END IF;
        -- The unique reservation index rejects unrelated names, including
        -- simultaneous assignments and names whose generations were deleted.
        INSERT INTO generation_name_owners (id, permanent_name, legacy_name_duplicate)
        VALUES (NEW.id, NEW.permanent_name, NEW.legacy_name_duplicate)
        ON CONFLICT (id) DO NOTHING;
    ELSE
        IF NOT (NEW.kind = 'video' AND NEW.model = 'Seedance 2.5' AND NEW.draft_mode IS FALSE AND
            EXISTS (SELECT 1 FROM generations draft WHERE draft.id = NEW.source_generation_id
                AND draft.id = NEW.name_owner_id AND draft.kind = 'video' AND draft.model = 'Seedance 2.5'
                AND draft.draft_mode IS TRUE AND draft.task_id = NEW.draft_task_id
                AND draft.permanent_name = NEW.permanent_name
                AND draft.name_owner_id = NEW.name_owner_id)) THEN
            RAISE EXCEPTION 'Only a Seedance draft final may share its name' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    SELECT permanent_name, legacy_name_duplicate INTO owner_name, owner_duplicate
        FROM generation_name_owners WHERE id=NEW.name_owner_id;
    IF NOT FOUND OR NEW.permanent_name IS DISTINCT FROM owner_name OR
       NEW.legacy_name_duplicate IS DISTINCT FROM owner_duplicate THEN
        RAISE EXCEPTION 'Generation name does not match its owner' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER trg_generation_permanent_name ON generations;
CREATE TRIGGER trg_generation_permanent_name BEFORE INSERT OR UPDATE OF
    id, permanent_name, name_owner_id, legacy_name_duplicate, source_generation_id, draft_task_id, kind, model, draft_mode
    ON generations FOR EACH ROW EXECUTE FUNCTION protect_generation_permanent_name();
CREATE FUNCTION protect_generation_name_owner() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'A permanent name reservation cannot change or be deleted' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_generation_name_owner BEFORE UPDATE OR DELETE ON generation_name_owners
    FOR EACH ROW EXECUTE FUNCTION protect_generation_name_owner();
"""

REVERSE = r"""
DROP TRIGGER trg_generation_name_owner ON generation_name_owners;
DROP FUNCTION protect_generation_name_owner();
DROP TRIGGER trg_generation_permanent_name ON generations;
CREATE OR REPLACE FUNCTION protect_generation_permanent_name() RETURNS trigger AS $$
BEGIN
    IF OLD.permanent_name IS NOT NULL AND NEW.permanent_name IS DISTINCT FROM OLD.permanent_name THEN
        RAISE EXCEPTION 'A generation permanent name cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_generation_permanent_name BEFORE UPDATE OF permanent_name ON generations
    FOR EACH ROW EXECUTE FUNCTION protect_generation_permanent_name();
-- Restore the previous uniqueness scheme without renaming any final. Keep
-- every original owner's ordinal; allocate additional legacy ordinals to finals.
WITH maxima AS (
    SELECT lower(permanent_name) AS name, max(legacy_name_duplicate) AS highest
    FROM generation_name_owners GROUP BY lower(permanent_name)
), finals AS (
    SELECT g.id, m.highest + row_number() OVER (PARTITION BY lower(g.permanent_name) ORDER BY g.created_at, g.id) AS ordinal
    FROM generations g JOIN maxima m ON m.name=lower(g.permanent_name)
    WHERE g.name_owner_id <> g.id
)
UPDATE generations g SET legacy_name_duplicate=finals.ordinal FROM finals WHERE g.id=finals.id;
"""


class Migration(migrations.Migration):
    dependencies = [('generation', '0004_generation_unique_permanent_name')]
    operations = [
        migrations.CreateModel(name='GenerationNameOwner', fields=[
            ('id', models.UUIDField(primary_key=True, serialize=False)),
            ('permanent_name', models.TextField()),
            ('legacy_name_duplicate', models.IntegerField(default=0, db_default=0)),
        ], options={'db_table': 'generation_name_owners', 'constraints': [models.UniqueConstraint(
            Lower('permanent_name'), models.F('legacy_name_duplicate'), name='generation_name_owners_name_key')]}),
        migrations.AddField(model_name='generation', name='name_owner', field=models.ForeignKey(
            to='generation.generationnameowner', null=True, db_index=False, on_delete=django.db.models.deletion.RESTRICT)),
        migrations.RunSQL(BACKFILL, migrations.RunSQL.noop),
        migrations.RemoveConstraint(model_name='generation', name='generations_permanent_name_key'),
        migrations.RunSQL(PROTECT, REVERSE),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT ON generation_name_owners TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON generation_name_owners TO goal4_green_history_writer;
    END IF;
END $$;
""", migrations.RunSQL.noop),
    ]
