"""Database connection profile of each production component (docs/operations/database-connections.md).

``VEEVEE_DB_POOLED=1`` means the connection goes through the transaction-mode PgBouncer (infra/pgbouncer), one alias
per component (``veevee_<component>``); otherwise it is the direct PostgreSQL URL. Both profiles are valid, so the
pooler can be switched on and off per service with one variable and no deploy order constraint.

The timeouts bound how long one component can hold a PostgreSQL connection: a statement, or a transaction left idle
(for example by a worker blocked on a provider call inside ``atomic``). Direct connections send them as startup
options. A pooled connection must not: PostgreSQL does not report them, so PgBouncer cannot track them per client and
would apply the first client's values to every client sharing a server connection. The pooler sets them per alias
instead (``connect_query`` in infra/pgbouncer/pgbouncer.ini.template, kept equal to ``TIMEOUTS_MS`` by a test).
"""
# component: (statement_timeout, idle_in_transaction_session_timeout), in milliseconds
TIMEOUTS_MS = {
    'api': (30000, 30000),
    'mcp': (30000, 30000),
    'agent': (30000, 30000),
    'generation': (60000, 60000),
    'export': (120000, 60000),
    'scheduler': (120000, 60000),
}
# Seconds a direct connection stays open between requests. Request-serving processes keep it short because each
# idle connection holds a PostgreSQL backend; pooled clients are cheap (the pooler holds no server for them).
DIRECT_CONN_MAX_AGE = {'api': 10, 'mcp': 10, 'agent': 10}
DIRECT_DEFAULT_CONN_MAX_AGE = 60
POOLED_CONN_MAX_AGE = 600


def alias(component):
    return f'veevee_{component}'


def startup_options(component):
    statement, idle = TIMEOUTS_MS[component]
    return f'-c statement_timeout={statement} -c idle_in_transaction_session_timeout={idle}'


def apply(database, component, pooled):
    """Mutate one ``DATABASES`` entry for the component and the connection kind."""
    options = database.setdefault('OPTIONS', {})
    if component:
        options.setdefault('application_name', f'veevee-{component}')
    if pooled:
        # Transaction pooling: no server-side cursors, no psycopg auto-prepared statements (a statement prepared on
        # one server connection does not exist on the next), long-lived client connections.
        database['DISABLE_SERVER_SIDE_CURSORS'] = True
        options['prepare_threshold'] = None
        database['CONN_MAX_AGE'] = POOLED_CONN_MAX_AGE
        return database
    database['CONN_MAX_AGE'] = DIRECT_CONN_MAX_AGE.get(component, DIRECT_DEFAULT_CONN_MAX_AGE)
    if component:
        options.setdefault('options', startup_options(component))
    return database
