"""Worker lease/naming namespaces and read-only pricing (ported from launchers).

Green workers allocate generation filename sequences in a private naming
namespace seeded from the canonical counter, and hold leases under a private
prefix. Both are live production state: changing them would alter future
filenames or let two lease namespaces overlap, so they are preserved exactly.
"""


def install_leases(module, prefix):
    if not (prefix.startswith('lease:') and prefix.endswith(':')):
        raise ValueError('Lease prefix must start with "lease:" and end with ":"')

    def key(value):
        if not isinstance(value, str) or not value.startswith('lease:'):
            raise ValueError('Invalid lease key')
        return prefix + value[len('lease:'):]

    for name in ('claim', 'read', 'release', 'delete_expired'):
        original = getattr(module, name)

        def wrapped(lease, *args, _original=original, **kwargs):
            return _original(key(lease), *args, **kwargs)
        setattr(module, name, wrapped)


def install_naming(module, prefix):
    if not prefix.endswith(':') or len(prefix) < 4:
        raise ValueError('Naming prefix must end with ":"')
    original = module.allocate_next_sequence

    def allocate(namespace, count=1, now=None):
        private = prefix + namespace
        from django.db import connection
        with connection.cursor() as cursor:
            cursor.execute('SELECT next_sequence FROM naming_counters WHERE namespace=%s', [namespace])
            row = cursor.fetchone()
            seed = max(1, int(row[0])) if row else 1
            cursor.execute('INSERT INTO naming_counters(namespace,next_sequence,updated_at) VALUES(%s,%s,%s) '
                           'ON CONFLICT(namespace) DO NOTHING', [private, seed, module.now_ms() if now is None else now])
        return original(private, count, now)
    module.allocate_next_sequence = allocate


def install_readonly_pricing(component):
    """Price reads never write; the API view also fills in default models."""
    from apps.admin_dashboard import queries
    from apps.admin_dashboard.models import Pricing

    def rows():
        return [{'model': row.model, 'unitCostCents': row.unit_cost_cents, 'unit': row.unit, 'notes': row.notes}
                for row in Pricing.objects.all()]

    if component == 'api':
        def price_rows():
            result = rows()
            present = {row['model'] for row in result}
            for default in queries.DEFAULT_PRICING:
                if default['model'] not in present:
                    result.append(dict(default))
                    present.add(default['model'])
            return result
    else:
        price_rows = rows
    queries.price_rows = price_rows
