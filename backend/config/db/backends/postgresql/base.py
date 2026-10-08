from django.db.backends.postgresql.base import DatabaseWrapper as PostgreSQLDatabaseWrapper
from .schema import DatabaseSchemaEditor


class DatabaseWrapper(PostgreSQLDatabaseWrapper):
    SchemaEditorClass = DatabaseSchemaEditor
