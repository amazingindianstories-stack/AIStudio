from django.db import migrations, models
from apps.library.baseline_sql.permanent_names_v1 import resolve_generation_filename


def freeze_existing(apps, schema_editor):
    Generation = apps.get_model('generation', 'Generation')
    Naming = apps.get_model('library', 'GenerationNaming')
    Folder = apps.get_model('library', 'Folder')
    alias = schema_editor.connection.alias
    # Generation DDL already holds its table lock. Keep folder ancestry stable
    # throughout the snapshot/backfill as well. Release with writers quiesced.
    schema_editor.execute('LOCK TABLE folders IN SHARE MODE')
    folders = {row['id']: row for row in Folder.objects.using(alias).values('id', 'name', 'parent_id')}
    # Chunk to bound generation/naming memory; every row including unnamed legacy
    # rows keeps precisely the name that the old reader would have returned.
    batch = []
    for generation in Generation.objects.using(alias).order_by('id').iterator(chunk_size=1000):
        batch.append(generation)
        if len(batch) == 1000:
            freeze_batch(Generation, Naming, folders, batch, alias)
            batch = []
    freeze_batch(Generation, Naming, folders, batch, alias)


def freeze_batch(Generation, Naming, folders, batch, alias):
    names = {n.generation_id: n for n in Naming.objects.using(alias).filter(generation_id__in=[g.id for g in batch])}
    for generation in batch:
        naming = names.get(generation.id)
        namespace = (naming.namespace if naming else None) or (f'folder:{generation.folder_id}' if generation.folder_id else
            f'project_unsorted:{generation.project_id}' if generation.project_id else 'global_unsorted')
        ancestry, seen, current = [], set(), folders.get(generation.folder_id)
        while current and current['id'] not in seen:
            seen.add(current['id'])
            ancestry.insert(0, current)
            current = folders.get(current['parent_id'])
        generation.permanent_name = resolve_generation_filename(ancestry, namespace,
            naming.sequence if naming else 1, generation.kind, generation.url).rsplit('.', 1)[0]
    Generation.objects.using(alias).bulk_update(batch, ['permanent_name'], batch_size=1000)


PREVIOUS_NAMING_TRIGGER = r"""CREATE OR REPLACE FUNCTION check_generation_naming_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     gen_folder UUID;
     gen_project UUID;
     expected_ns TEXT;
     allocated_seq BIGINT;
     now_ts BIGINT;
   BEGIN
     IF TG_TABLE_NAME = 'generation_naming' THEN
       SELECT folder_id, project_id INTO gen_folder, gen_project
       FROM generations WHERE id = NEW.generation_id;
       IF NOT FOUND THEN
         RETURN NEW;
       END IF;

       IF gen_folder IS NOT NULL THEN
         expected_ns := 'folder:' || gen_folder::text;
       ELSIF gen_project IS NOT NULL THEN
         expected_ns := 'project_unsorted:' || gen_project::text;
       ELSE
         expected_ns := 'global_unsorted';
       END IF;

       IF NEW.namespace IS DISTINCT FROM expected_ns THEN
         RAISE EXCEPTION 'Naming namespace mismatch: namespace (%) does not match generation (%) location (%)',
           NEW.namespace, NEW.generation_id, expected_ns USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;

     ELSIF TG_TABLE_NAME = 'generations' THEN
       now_ts := ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;

       IF NEW.folder_id IS NOT NULL THEN
         expected_ns := 'folder:' || NEW.folder_id::text;
       ELSIF NEW.project_id IS NOT NULL THEN
         expected_ns := 'project_unsorted:' || NEW.project_id::text;
       ELSE
         expected_ns := 'global_unsorted';
       END IF;

       IF TG_OP = 'INSERT' THEN
         -- Auto-assign naming row if omitted (supports old application inserts)
         IF NOT EXISTS (SELECT 1 FROM generation_naming WHERE generation_id = NEW.id) THEN
           INSERT INTO naming_counters (namespace, next_sequence, updated_at)
           VALUES (expected_ns, 2, now_ts)
           ON CONFLICT (namespace) DO UPDATE SET
             next_sequence = naming_counters.next_sequence + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING next_sequence - 1 INTO allocated_seq;

           INSERT INTO generation_naming (generation_id, namespace, sequence, assigned_at)
           VALUES (NEW.id, expected_ns, allocated_seq, now_ts)
           ON CONFLICT (generation_id) DO NOTHING;
         END IF;
         RETURN NEW;

       ELSIF TG_OP = 'UPDATE' AND (NEW.folder_id IS DISTINCT FROM OLD.folder_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
         -- Auto-reassign naming row if omitted or mismatched (supports old application moves, code rollback, and direct SQL)
         IF NOT EXISTS (SELECT 1 FROM generation_naming WHERE generation_id = NEW.id) THEN
           INSERT INTO naming_counters (namespace, next_sequence, updated_at)
           VALUES (expected_ns, 2, now_ts)
           ON CONFLICT (namespace) DO UPDATE SET
             next_sequence = naming_counters.next_sequence + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING next_sequence - 1 INTO allocated_seq;

           INSERT INTO generation_naming (generation_id, namespace, sequence, assigned_at)
           VALUES (NEW.id, expected_ns, allocated_seq, now_ts)
           ON CONFLICT (generation_id) DO NOTHING;
         ELSIF EXISTS (
           SELECT 1 FROM generation_naming
           WHERE generation_id = NEW.id AND namespace IS DISTINCT FROM expected_ns
         ) THEN
           INSERT INTO naming_counters (namespace, next_sequence, updated_at)
           VALUES (expected_ns, 2, now_ts)
           ON CONFLICT (namespace) DO UPDATE SET
             next_sequence = naming_counters.next_sequence + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING next_sequence - 1 INTO allocated_seq;

           UPDATE generation_naming
           SET namespace = expected_ns, sequence = allocated_seq, assigned_at = now_ts
           WHERE generation_id = NEW.id;
         END IF;
       END IF;
       RETURN NEW;
     END IF;

     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql"""

PERMANENT_NAMING_TRIGGER = r"""CREATE OR REPLACE FUNCTION check_generation_naming_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     gen_folder UUID;
     gen_project UUID;
     expected_ns TEXT;
     allocated_seq BIGINT;
     now_ts BIGINT;
   BEGIN
     IF TG_TABLE_NAME = 'generation_naming' THEN
       IF EXISTS (SELECT 1 FROM generations WHERE id=NEW.generation_id AND permanent_name IS NOT NULL) THEN
         RETURN NEW;
       END IF;
       SELECT folder_id, project_id INTO gen_folder, gen_project
       FROM generations WHERE id = NEW.generation_id;
       IF NOT FOUND THEN
         RETURN NEW;
       END IF;

       IF gen_folder IS NOT NULL THEN
         expected_ns := 'folder:' || gen_folder::text;
       ELSIF gen_project IS NOT NULL THEN
         expected_ns := 'project_unsorted:' || gen_project::text;
       ELSE
         expected_ns := 'global_unsorted';
       END IF;

       IF NEW.namespace IS DISTINCT FROM expected_ns THEN
         RAISE EXCEPTION 'Naming namespace mismatch: namespace (%) does not match generation (%) location (%)',
           NEW.namespace, NEW.generation_id, expected_ns USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;

     ELSIF TG_TABLE_NAME = 'generations' THEN
       IF EXISTS (SELECT 1 FROM generations WHERE id=NEW.id AND permanent_name IS NOT NULL) THEN
         RETURN NEW;
       END IF;
       now_ts := ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;

       IF NEW.folder_id IS NOT NULL THEN
         expected_ns := 'folder:' || NEW.folder_id::text;
       ELSIF NEW.project_id IS NOT NULL THEN
         expected_ns := 'project_unsorted:' || NEW.project_id::text;
       ELSE
         expected_ns := 'global_unsorted';
       END IF;

       IF TG_OP = 'INSERT' THEN
         -- Auto-assign naming row if omitted (supports old application inserts)
         IF NOT EXISTS (SELECT 1 FROM generation_naming WHERE generation_id = NEW.id) THEN
           INSERT INTO naming_counters (namespace, next_sequence, updated_at)
           VALUES (expected_ns, 2, now_ts)
           ON CONFLICT (namespace) DO UPDATE SET
             next_sequence = naming_counters.next_sequence + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING next_sequence - 1 INTO allocated_seq;

           INSERT INTO generation_naming (generation_id, namespace, sequence, assigned_at)
           VALUES (NEW.id, expected_ns, allocated_seq, now_ts)
           ON CONFLICT (generation_id) DO NOTHING;
         END IF;
         RETURN NEW;

       ELSIF TG_OP = 'UPDATE' AND (NEW.folder_id IS DISTINCT FROM OLD.folder_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
         -- Auto-reassign naming row if omitted or mismatched (supports old application moves, code rollback, and direct SQL)
         IF NOT EXISTS (SELECT 1 FROM generation_naming WHERE generation_id = NEW.id) THEN
           INSERT INTO naming_counters (namespace, next_sequence, updated_at)
           VALUES (expected_ns, 2, now_ts)
           ON CONFLICT (namespace) DO UPDATE SET
             next_sequence = naming_counters.next_sequence + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING next_sequence - 1 INTO allocated_seq;

           INSERT INTO generation_naming (generation_id, namespace, sequence, assigned_at)
           VALUES (NEW.id, expected_ns, allocated_seq, now_ts)
           ON CONFLICT (generation_id) DO NOTHING;
         ELSIF EXISTS (
           SELECT 1 FROM generation_naming
           WHERE generation_id = NEW.id AND namespace IS DISTINCT FROM expected_ns
         ) THEN
           INSERT INTO naming_counters (namespace, next_sequence, updated_at)
           VALUES (expected_ns, 2, now_ts)
           ON CONFLICT (namespace) DO UPDATE SET
             next_sequence = naming_counters.next_sequence + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING next_sequence - 1 INTO allocated_seq;

           UPDATE generation_naming
           SET namespace = expected_ns, sequence = allocated_seq, assigned_at = now_ts
           WHERE generation_id = NEW.id;
         END IF;
       END IF;
       RETURN NEW;
     END IF;

     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql"""


class Migration(migrations.Migration):
    dependencies = [('generation', '0002_generation_submission_input'), ('library', '0005_railway_v2_invariants')]
    operations = [
        migrations.AddField(model_name='generation', name='permanent_name', field=models.TextField(null=True)),
        migrations.RunPython(freeze_existing, migrations.RunPython.noop),
        migrations.RunSQL(PERMANENT_NAMING_TRIGGER, PREVIOUS_NAMING_TRIGGER),
        migrations.RunSQL(r"""
CREATE FUNCTION protect_generation_permanent_name() RETURNS trigger AS $$
BEGIN
    IF OLD.permanent_name IS NOT NULL AND NEW.permanent_name IS DISTINCT FROM OLD.permanent_name THEN
        RAISE EXCEPTION 'A generation permanent name cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_generation_permanent_name BEFORE UPDATE OF permanent_name ON generations
FOR EACH ROW EXECUTE FUNCTION protect_generation_permanent_name();
""", "DROP TRIGGER trg_generation_permanent_name ON generations; DROP FUNCTION protect_generation_permanent_name();"),
    ]
