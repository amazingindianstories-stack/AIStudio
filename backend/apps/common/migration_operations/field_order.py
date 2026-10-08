from django.db.migrations.operations.base import Operation


class SetModelFieldOrder(Operation):
    """Freeze baseline creation order without altering an existing table.

    PostgreSQL cannot reorder columns with ALTER TABLE. This state-only operation
    describes fresh baseline creation; it must never rebuild production tables.
    """

    reversible = True
    reduces_to_sql = False

    def __init__(self, name, fields):
        self.name = name
        self.fields = tuple(fields)

    def state_forwards(self, app_label, state):
        model = state.models[app_label, self.name.lower()]
        if len(self.fields) != len(set(self.fields)) or set(self.fields) != set(model.fields):
            raise ValueError('Baseline field order must name every model field exactly once')
        model.fields = {name: model.fields[name] for name in self.fields}
        state.reload_model(app_label, self.name.lower(), delay=True)

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        pass

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        pass

    def describe(self):
        return f'Freeze fresh baseline field order for {self.name}'
