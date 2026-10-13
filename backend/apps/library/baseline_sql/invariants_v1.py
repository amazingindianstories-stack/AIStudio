"""Frozen hierarchy/naming functions and triggers for the managed baseline.

Source: scripts/migrate-hierarchical-folders.js and migrate-generation-naming.js.
Frozen SQL; future changes must use a new version. The active managed graph
applies this through RunSQL after all tables exist. Production adoption remains
a separately reviewed deployment operation.
"""

STATEMENTS = (
    r"""CREATE OR REPLACE FUNCTION sync_folder_name_normalized()
   RETURNS TRIGGER AS $$
   BEGIN
     IF NEW.name IS NOT NULL THEN
       NEW.name_normalized := LOWER(TRIM(NORMALIZE(NEW.name, NFKC)));
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql""",
    r"""DROP TRIGGER IF EXISTS trg_sync_folder_name_normalized ON folders""",
    r"""CREATE TRIGGER trg_sync_folder_name_normalized BEFORE INSERT OR UPDATE OF name ON folders FOR EACH ROW EXECUTE FUNCTION sync_folder_name_normalized()""",
    r"""CREATE OR REPLACE FUNCTION check_folder_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     parent_proj UUID;
     child_count INT;
     gen_count INT;
   BEGIN
     -- 1. If child folder has parent, verify child's project matches parent's project
     IF NEW.parent_id IS NOT NULL THEN
       SELECT project_id INTO parent_proj FROM folders WHERE id = NEW.parent_id;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'Parent folder % does not exist', NEW.parent_id USING ERRCODE = 'foreign_key_violation';
       END IF;
       IF NEW.project_id IS DISTINCT FROM parent_proj THEN
         RAISE EXCEPTION 'Folder scope mismatch: child project_id (%) does not match parent project_id (%)',
           NEW.project_id, parent_proj USING ERRCODE = 'check_violation';
       END IF;
     END IF;

     -- 2. If folder project_id was updated directly, verify all child folders match NEW.project_id
     IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
       SELECT count(*)::int INTO child_count
       FROM folders
       WHERE parent_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id;

       IF child_count > 0 THEN
         RAISE EXCEPTION 'Folder scope mismatch: parent project_id (%) update leaves % child folders with mismatched scope',
           NEW.project_id, child_count USING ERRCODE = 'check_violation';
       END IF;

       -- Also verify any generations in this folder match NEW.project_id
       SELECT count(*)::int INTO gen_count
       FROM generations
       WHERE folder_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id;

       IF gen_count > 0 THEN
         RAISE EXCEPTION 'Generation scope mismatch: folder project_id (%) update leaves % generations with mismatched scope',
           NEW.project_id, gen_count USING ERRCODE = 'check_violation';
       END IF;
     END IF;

     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql""",
    r"""DROP TRIGGER IF EXISTS trg_check_folder_scope ON folders""",
    r"""CREATE CONSTRAINT TRIGGER trg_check_folder_scope AFTER INSERT OR UPDATE OF parent_id, project_id ON folders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_folder_scope_integrity()""",
    r"""CREATE OR REPLACE FUNCTION check_generation_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     folder_proj UUID;
   BEGIN
     IF NEW.folder_id IS NOT NULL THEN
       SELECT project_id INTO folder_proj FROM folders WHERE id = NEW.folder_id;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'Referenced folder % does not exist', NEW.folder_id USING ERRCODE = 'foreign_key_violation';
       END IF;
       IF NEW.project_id IS DISTINCT FROM folder_proj THEN
         RAISE EXCEPTION 'Generation scope mismatch: generation project_id (%) does not match folder project_id (%)',
           NEW.project_id, folder_proj USING ERRCODE = 'check_violation';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql""",
    r"""DROP TRIGGER IF EXISTS trg_check_generation_scope ON generations""",
    r"""CREATE CONSTRAINT TRIGGER trg_check_generation_scope AFTER INSERT OR UPDATE OF folder_id, project_id ON generations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_generation_scope_integrity()""",
    r"""CREATE OR REPLACE FUNCTION check_generation_naming_scope_integrity()
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
   $$ LANGUAGE plpgsql""",
    r"""DROP TRIGGER IF EXISTS trg_check_generation_naming_scope ON generation_naming""",
    r"""CREATE CONSTRAINT TRIGGER trg_check_generation_naming_scope
   AFTER INSERT OR UPDATE ON generation_naming
   DEFERRABLE INITIALLY DEFERRED
   FOR EACH ROW
   EXECUTE FUNCTION check_generation_naming_scope_integrity()""",
    r"""DROP TRIGGER IF EXISTS trg_check_generation_location_naming ON generations""",
    r"""CREATE CONSTRAINT TRIGGER trg_check_generation_location_naming
   AFTER INSERT OR UPDATE OF folder_id, project_id ON generations
   DEFERRABLE INITIALLY DEFERRED
   FOR EACH ROW
   EXECUTE FUNCTION check_generation_naming_scope_integrity()""",
)
