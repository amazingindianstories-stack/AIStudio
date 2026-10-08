from django.db.backends.postgresql.schema import DatabaseSchemaEditor as PostgreSQLSchemaEditor


# These current production text keys have ordinary PK/unique indexes only.
# Preserve their layout during Django schema creation/alteration. Add any new
# pattern index explicitly through a reviewed migration rather than implicitly.
CURRENT_TEXT_KEYS_WITHOUT_PATTERN_INDEX = frozenset({
    ('users', 'email'),
    ('depth_workers', 'worker_id'),
    ('portrait_groups', 'byteplus_group_id'),
    ('portrait_assets', 'byteplus_asset_id'),
    ('organization_idempotency_keys', 'key'),
    ('naming_counters', 'namespace'),
    ('pricing', 'model'),
    ('settings', 'key'),
})


class DatabaseSchemaEditor(PostgreSQLSchemaEditor):
    def _create_like_index_sql(self, model, field):
        if (model._meta.db_table, field.column) in CURRENT_TEXT_KEYS_WITHOUT_PATTERN_INDEX:
            return None
        return super()._create_like_index_sql(model, field)

    def _create_fk_sql(self, model, field, suffix):
        statement = super()._create_fk_sql(model, field, suffix)
        policy = CURRENT_FOREIGN_KEYS.get((model._meta.db_table, field.column))
        if policy is not None:
            target_table, target_column, action, name = policy
            if (field.target_field.model._meta.db_table, field.target_field.column) != (target_table, target_column):
                raise ValueError('Current foreign-key target changed; review schema policy')
            statement.parts['name'] = self.quote_name(name)
            statement.parts['deferrable'] = 'ON DELETE ' + action + ' NOT DEFERRABLE'
        return statement

    def add_field(self, model, field):
        # PostgreSQL's inline ADD COLUMN shortcut bypasses _create_fk_sql.
        # Route these exact legacy relationships through the same policy.
        if (model._meta.db_table, field.column) not in CURRENT_FOREIGN_KEYS:
            return super().add_field(model, field)
        inline = self.sql_create_column_inline_fk
        try:
            self.sql_create_column_inline_fk = None
            return super().add_field(model, field)
        finally:
            self.sql_create_column_inline_fk = inline


# Current Drizzle FK names. Additive script aliases/duplicates are audited
# separately; this policy neither drops nor renames existing constraints.
CURRENT_FOREIGN_KEYS = {
    ('folders', 'project_id'): ('projects', 'id', 'RESTRICT', 'folders_project_id_projects_id_fk'),
    ('folders', 'parent_id'): ('folders', 'id', 'RESTRICT', 'folders_parent_id_folders_id_fk'),
    ('generations', 'project_id'): ('projects', 'id', 'RESTRICT', 'generations_project_id_projects_id_fk'),
    ('generations', 'folder_id'): ('folders', 'id', 'RESTRICT', 'generations_folder_id_folders_id_fk'),
    ('generation_naming', 'generation_id'): ('generations', 'id', 'CASCADE', 'generation_naming_generation_id_generations_id_fk'),
    ('portrait_assets', 'group_id'): ('portrait_groups', 'id', 'CASCADE', 'portrait_assets_group_id_portrait_groups_id_fk'),
    ('media_export_items', 'export_id'): ('media_exports', 'id', 'CASCADE', 'media_export_items_export_id_media_exports_id_fk'),
}
