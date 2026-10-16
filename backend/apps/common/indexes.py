from django.db.models import Index


class PostgreSQLIndex(Index):
    """Preserve existing PostgreSQL names beyond Django's portable 30-char limit."""
    max_name_length = 63


class PostgreSQLUniqueIndex(PostgreSQLIndex):
    """Preserve a named unique index, including partial index predicates.

    A UniqueConstraint would change the catalog object kind for an unconditional
    existing unique index. Retain the original index form for baseline fidelity.
    """
    def create_sql(self, model, schema_editor, using="", **kwargs):
        if schema_editor.connection.vendor != 'postgresql':
            raise ValueError('PostgreSQLUniqueIndex requires PostgreSQL')
        kwargs['sql'] = schema_editor.sql_create_index.replace('CREATE INDEX', 'CREATE UNIQUE INDEX', 1)
        return super().create_sql(model, schema_editor, using=using, **kwargs)
