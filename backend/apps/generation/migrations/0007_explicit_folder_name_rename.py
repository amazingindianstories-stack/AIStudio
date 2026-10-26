"""Audited explicit renames; retain every historical name reservation."""
import importlib
from django.db import migrations, models

PREVIOUS = importlib.import_module('apps.generation.migrations.0005_generation_name_owner').PROTECT

AUDIT_CHECK = """
        IF NEW.id = OLD.id AND NEW.name_owner_id = OLD.name_owner_id AND
           NEW.legacy_name_duplicate = 0 AND
           NEW.source_generation_id IS NOT DISTINCT FROM OLD.source_generation_id AND
           NEW.draft_task_id IS NOT DISTINCT FROM OLD.draft_task_id AND
           NEW.kind = OLD.kind AND NEW.model = OLD.model AND
           NEW.draft_mode IS NOT DISTINCT FROM OLD.draft_mode AND
           EXISTS (SELECT 1 FROM public.generation_name_changes c WHERE c.generation_id=OLD.id
               AND c.transaction_id=txid_current() AND c.old_name=OLD.permanent_name
               AND c.new_name=NEW.permanent_name) AND
           EXISTS (SELECT 1 FROM public.generation_name_owners o WHERE o.id=NEW.name_owner_id
               AND o.permanent_name=NEW.permanent_name AND o.legacy_name_duplicate=0) THEN
            RETURN NEW;
        END IF;
"""
# Reuse the previous, frozen validator with just the audited exception added.
VALIDATOR = PREVIOUS.split('DROP TRIGGER trg_generation_permanent_name')[0].replace(
    "    IF TG_OP = 'UPDATE' AND OLD.permanent_name IS NOT NULL THEN",
    "    IF TG_OP = 'UPDATE' AND OLD.permanent_name IS NOT NULL THEN" + AUDIT_CHECK)

SQL = VALIDATOR + r"""
CREATE OR REPLACE FUNCTION protect_generation_name_owner() RETURNS trigger AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW.id=OLD.id AND NEW.legacy_name_duplicate=0 AND
       EXISTS (SELECT 1 FROM public.generation_name_changes c JOIN public.generations g ON g.id=c.generation_id
           WHERE g.name_owner_id=OLD.id AND c.transaction_id=txid_current()
               AND c.old_name=OLD.permanent_name AND c.new_name=NEW.permanent_name) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A permanent name reservation cannot change or be deleted' USING ERRCODE='check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION protect_generation_name_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Name change history is immutable' USING ERRCODE='check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_generation_name_change BEFORE UPDATE OR DELETE ON generation_name_changes
    FOR EACH ROW EXECUTE FUNCTION protect_generation_name_change();

CREATE FUNCTION rename_generation_lineage(owner_id UUID, new_name TEXT, actor UUID, stamp BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
    old_name TEXT;
    old_duplicate INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=actor AND role='admin' AND is_active) THEN
        RAISE EXCEPTION 'Only admins can rename generations' USING ERRCODE='insufficient_privilege';
    END IF;
    IF new_name IS NULL OR new_name='' THEN
        RAISE EXCEPTION 'A replacement name is required' USING ERRCODE='check_violation';
    END IF;
    SELECT permanent_name,legacy_name_duplicate INTO STRICT old_name,old_duplicate
        FROM public.generation_name_owners WHERE id=owner_id FOR UPDATE;
    IF new_name=old_name THEN RETURN; END IF;
    INSERT INTO public.generation_name_changes
        (id,generation_id,old_name,new_name,actor_id,changed_at,transaction_id)
        SELECT gen_random_uuid(),id,old_name,new_name,actor,stamp,txid_current()
        FROM public.generations WHERE name_owner_id=owner_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'No generations own this name'; END IF;
    UPDATE public.generation_name_owners SET permanent_name=new_name,legacy_name_duplicate=0 WHERE id=owner_id;
    -- Preserve the old name, even after the lineage or all its media is deleted.
    INSERT INTO public.generation_name_owners(id,permanent_name,legacy_name_duplicate)
        VALUES(gen_random_uuid(),old_name,old_duplicate);
    UPDATE public.generations SET permanent_name=new_name,legacy_name_duplicate=0,
        updated_at=GREATEST(stamp,updated_at+1) WHERE name_owner_id=owner_id;
END;
$$;
REVOKE ALL ON FUNCTION rename_generation_lineage(UUID,TEXT,UUID,BIGINT) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker', 'goal4_green_history_writer'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT ON generation_name_changes TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_preview_api') THEN
        GRANT EXECUTE ON FUNCTION rename_generation_lineage(UUID,TEXT,UUID,BIGINT) TO goal4_green_preview_api;
    END IF;
END $$;
"""

REVERSE = r"""
DROP FUNCTION rename_generation_lineage(UUID,TEXT,UUID,BIGINT);
DROP TRIGGER trg_generation_name_change ON generation_name_changes;
DROP FUNCTION protect_generation_name_change();
""" + PREVIOUS.split('DROP TRIGGER trg_generation_permanent_name')[0] + r"""
CREATE OR REPLACE FUNCTION protect_generation_name_owner() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'A permanent name reservation cannot change or be deleted' USING ERRCODE='check_violation';
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [('generation', '0006_generation_cancellation_state'), ('library', '0006_generation_naming_fallback')]
    operations = [
        migrations.CreateModel(name='GenerationNameChange', fields=[
            ('id', models.UUIDField(primary_key=True, serialize=False)),
            ('generation_id', models.UUIDField(db_index=True)),
            ('old_name', models.TextField()), ('new_name', models.TextField()),
            ('actor_id', models.UUIDField()), ('changed_at', models.BigIntegerField()),
            ('transaction_id', models.BigIntegerField()),
        ], options={'db_table': 'generation_name_changes'}),
        migrations.RunSQL(SQL, REVERSE),
    ]
