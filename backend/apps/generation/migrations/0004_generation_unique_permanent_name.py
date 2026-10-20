"""Library-wide case-insensitive permanent names; existing names are never renamed."""
from django.db import migrations, models
from django.db.models.functions import Lower


def mark_duplicates_and_seed_counters(apps, schema_editor):
    Generation = apps.get_model('generation', 'Generation')
    alias = schema_editor.connection.alias
    copies, duplicates, highest = {}, {}, {}
    rows = Generation.objects.using(alias).filter(permanent_name__isnull=False).order_by('created_at', 'id')
    for identifier, name in rows.values_list('id', 'permanent_name').iterator(chunk_size=1000):
        key = name.lower()
        ordinal = copies.get(key, 0)
        copies[key] = ordinal + 1
        if ordinal:
            duplicates.setdefault(ordinal, []).append(identifier)
        stem, _, serial = key.rpartition('_')
        if stem and serial.isdigit():
            highest[stem] = max(highest.get(stem, 0), int(serial))
    for ordinal, identifiers in duplicates.items():
        for start in range(0, len(identifiers), 1000):
            Generation.objects.using(alias).filter(pk__in=identifiers[start:start + 1000]).update(legacy_name_duplicate=ordinal)
    seeds = sorted(highest.items())
    with schema_editor.connection.cursor() as cursor:
        for start in range(0, len(seeds), 1000):
            cursor.executemany('''INSERT INTO naming_counters(namespace,next_sequence,updated_at)
                VALUES (%s,%s,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint) ON CONFLICT(namespace) DO UPDATE SET
                next_sequence=GREATEST(naming_counters.next_sequence,EXCLUDED.next_sequence)''',
                [('name:' + stem, sequence + 1) for stem, sequence in seeds[start:start + 1000]])


class Migration(migrations.Migration):
    dependencies = [('generation', '0003_generation_permanent_name'), ('library', '0005_railway_v2_invariants')]
    operations = [
        migrations.AddField(model_name='generation', name='legacy_name_duplicate',
            field=models.IntegerField(default=0, db_default=0)),
        migrations.RunPython(mark_duplicates_and_seed_counters, migrations.RunPython.noop),
        migrations.AddConstraint(model_name='generation', constraint=models.UniqueConstraint(
            Lower('permanent_name'), models.F('legacy_name_duplicate'),
            name='generations_permanent_name_key', condition=models.Q(permanent_name__isnull=False))),
    ]
