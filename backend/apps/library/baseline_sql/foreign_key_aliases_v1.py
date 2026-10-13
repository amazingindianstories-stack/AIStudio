"""Frozen additive-migration FK aliases for the managed Django baseline.

Preserve existing constraint names until the production catalog audit. These
statements are applied by the active RunSQL baseline. Production adoption is
separate from this local implementation.
"""

STATEMENTS = (
    r"""DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'folders'::regclass AND conname = 'folders_project_id_fkey') THEN
      ALTER TABLE folders ADD CONSTRAINT folders_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;
    END IF;
  END $$;""",
    r"""DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'folders'::regclass AND conname = 'folders_parent_id_fkey') THEN
      ALTER TABLE folders ADD CONSTRAINT folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE RESTRICT;
    END IF;
  END $$;""",
    r"""DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'generations'::regclass AND conname = 'generations_project_id_fkey') THEN
      ALTER TABLE generations ADD CONSTRAINT generations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;
    END IF;
  END $$;""",
    r"""DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'generations'::regclass AND conname = 'generations_folder_id_fkey') THEN
      ALTER TABLE generations ADD CONSTRAINT generations_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE RESTRICT;
    END IF;
  END $$;""",
    r"""DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'generation_naming'::regclass
        AND conname = 'generation_naming_generation_id_fkey'
    ) THEN
      ALTER TABLE generation_naming ADD CONSTRAINT generation_naming_generation_id_fkey
        FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE;
    END IF;
  END $$;""",
)
