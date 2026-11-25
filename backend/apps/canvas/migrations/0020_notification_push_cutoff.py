"""One-time push cutoff. The previous release pushed only notifications younger than ten minutes and left older
ones unpushed forever; this release pushes every unpushed notification younger than seven days. Marking the rows
that exist before this release as pushed keeps the first scheduler tick from sending a burst of stale pushes.
Data only; unapplying leaves the rows as they are."""
import time

from django.db import migrations


def mark_existing_pushed(apps, schema_editor):
    Notification = apps.get_model('canvas', 'Notification')
    Notification.objects.filter(pushed_at__isnull=True).update(pushed_at=int(time.time() * 1000))


class Migration(migrations.Migration):

    dependencies = [('canvas', '0019_format_payloads')]

    operations = [migrations.RunPython(mark_existing_pushed, migrations.RunPython.noop)]
