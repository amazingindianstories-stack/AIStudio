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
