"""Audit/adopt the legacy Drizzle catalog before Django owns migrations."""

from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.recorder import MigrationRecorder
from django.db.models.fields.composite import CompositePrimaryKey


LOCAL_LABELS = {
    "common", "assets", "generation", "projects", "canvas", "agents",
}


def _expected_models():
    return [
        model
        for model in apps.get_models()
        if model._meta.app_label in LOCAL_LABELS and model._meta.managed
    ]


def audit_catalog():
    if connection.vendor != "postgresql":
        return [f"DATABASE_URL uses {connection.vendor}; PostgreSQL is required"]

    problems = []
    with connection.cursor() as cursor:
        existing_tables = set(connection.introspection.table_names(cursor))
        for model in _expected_models():
            table = model._meta.db_table
            if table not in existing_tables:
                problems.append(f"missing table: {table}")
                continue

            description = connection.introspection.get_table_description(cursor, table)
            actual = {column.name: column for column in description}
            fields = [
                field for field in model._meta.local_fields
                if not isinstance(field, CompositePrimaryKey) and field.column
            ]
            expected_columns = {field.column: field for field in fields}
            missing = sorted(set(expected_columns) - set(actual))
            extra = sorted(set(actual) - set(expected_columns))
            if missing:
                problems.append(f"{table}: missing columns {', '.join(missing)}")
            if extra:
                problems.append(f"{table}: unexpected columns {', '.join(extra)}")

            constraints = connection.introspection.get_constraints(cursor, table)
            cursor.execute(
                """SELECT index_class.relname, index_row.indpred IS NOT NULL
                     FROM pg_index index_row
                     JOIN pg_class table_class ON table_class.oid = index_row.indrelid
                     JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
                    WHERE table_class.oid = %s::regclass""",
                [table],
            )
            partial_indexes = dict(cursor.fetchall())
            primary_columns = {
                column
                for constraint in constraints.values()
                if constraint.get("primary_key")
                for column in constraint.get("columns", [])
            }
            expected_primary = {field.column for field in fields if field.primary_key}
            if model._meta.pk and isinstance(model._meta.pk, CompositePrimaryKey):
                expected_primary = {field.column for field in model._meta.pk.fields}
            if primary_columns != expected_primary:
                problems.append(
                    f"{table}: primary key is {sorted(primary_columns)}, expected {sorted(expected_primary)}"
                )

            expected_index_names = {index.name for index in model._meta.indexes}
            for index in model._meta.indexes:
                name = index.name
                actual_index = constraints.get(name)
                if not actual_index or not actual_index.get("index"):
                    problems.append(f"{table}: missing index {name}")
                    continue
                expected_index_columns = [
                    model._meta.get_field(field.lstrip("-")).column for field in index.fields
                ]
                if actual_index.get("columns") != expected_index_columns:
                    problems.append(
                        f"{table}.{name}: columns are {actual_index.get('columns')}, "
                        f"expected {expected_index_columns}"
                    )
                expected_orders = ["DESC" if field.startswith("-") else "ASC" for field in index.fields]
                actual_orders = actual_index.get("orders") or ["ASC"] * len(expected_orders)
                if actual_orders != expected_orders:
                    problems.append(
                        f"{table}.{name}: ordering is {actual_orders}, expected {expected_orders}"
                    )
                if bool(partial_indexes.get(name)) != bool(index.condition):
                    problems.append(f"{table}.{name}: partial-index condition differs")

            unique_columns = {field.column for field in fields if field.unique or field.primary_key}
            unexpected_indexes = sorted(
                name for name, value in constraints.items()
                if value.get("index") and not value.get("primary_key") and not value.get("unique")
                and name not in expected_index_names
                and not (
                    name.endswith("_like") and len(value.get("columns") or []) == 1
                    and value["columns"][0] in unique_columns
                )
            )
            if unexpected_indexes:
                problems.append(f"{table}: unexpected indexes {', '.join(unexpected_indexes)}")

            for field in fields:
                if field.unique and not field.primary_key:
                    matching_unique = any(
                        value.get("unique") and value.get("columns") == [field.column]
                        for value in constraints.values()
                    )
                    if not matching_unique:
                        problems.append(f"{table}.{field.column}: missing unique constraint")

            for column, field in expected_columns.items():
                info = actual.get(column)
                if not info:
                    continue
                actual_type = connection.introspection.get_field_type(info.type_code, info)
                expected_type = field.get_internal_type()
                if actual_type != expected_type:
                    problems.append(f"{table}.{column}: type is {actual_type}, expected {expected_type}")
                if bool(info.null_ok) != bool(field.null):
                    problems.append(f"{table}.{column}: nullability differs")
    return problems


class Command(BaseCommand):
    help = "Fail on catalog drift; optionally record exact legacy schema as adopted."

    def add_arguments(self, parser):
        parser.add_argument("--adopt", action="store_true")
        parser.add_argument("--require-adopted", action="store_true")

    def handle(self, *args, **options):
        problems = audit_catalog()
        if problems:
            raise CommandError("Schema preflight failed:\n- " + "\n- ".join(problems))

        loader = MigrationLoader(connection, ignore_no_migrations=True)
        local_nodes = sorted(node for node in loader.graph.nodes if node[0] in LOCAL_LABELS)
        recorder = MigrationRecorder(connection)
        applied = set(recorder.applied_migrations())

        if options["require_adopted"]:
            missing = [f"{app}.{name}" for app, name in local_nodes if (app, name) not in applied]
            if missing:
                raise CommandError("Schema matches, but migrations are not adopted: " + ", ".join(missing))

        if options["adopt"]:
            for app_label, migration_name in local_nodes:
                if (app_label, migration_name) not in applied:
                    recorder.record_applied(app_label, migration_name)
            self.stdout.write(self.style.SUCCESS(f"Adopted {len(local_nodes)} local migrations after exact catalog audit."))
        else:
            self.stdout.write(self.style.SUCCESS("Catalog matches Django model state."))
