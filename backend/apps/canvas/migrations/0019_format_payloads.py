"""Large format payloads (Docs blocks, HTML embeds, draw.io XML and previews) get their own rows, one per board
and node. This is the expand step: a node with inline payload fields gets its row (an existing row with the same
content is kept) and a reference, and keeps the inline fields. The previous release must not serve once this is
applied: it drops the reference and saves edits into the inline fields, which this release ignores for a node
whose row exists, and a save of a board this release has saved stores its payloads empty. So it is applied only
inside the release's no-overlap pause, after the old API and MCP service stop and before the new ones serve
(docs/operations/release-runbook.md). The data step is idempotent, and the board version and update time do not
change, so editors with a save in flight are unaffected. Unapplying puts every row back inline into a node
without its fields and drops the reference before the table goes."""
import hashlib
import json
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models

PROBE = {'doc': 'blocks', 'html': 'html', 'drawio': 'xml'}
FIELDS = {'doc': ('blocks', 'suggestions'), 'html': ('html',), 'drawio': ('xml', 'preview')}


def _body(node):
    if node['format'] == 'doc':
        return {'blocks': node['blocks'], 'suggestions': node.get('suggestions', [])}
    if node['format'] == 'html':
        return {'html': node['html']}
    return {'xml': node['xml'], 'preview': node.get('preview', '')}


def _units(text):
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def move_payloads(apps, schema_editor):
    Board, Payload = apps.get_model('canvas', 'CanvasBoard'), apps.get_model('canvas', 'BoardFormatPayload')
    for board in Board.objects.filter(data__nodes__contains=[{'type': 'format'}]).iterator(chunk_size=50):
        nodes = board.data.get('nodes') if isinstance(board.data, dict) else None
        if not isinstance(nodes, list):
            continue
        changed = False
        for node in nodes:
            if not (isinstance(node, dict) and node.get('type') == 'format' and node.get('format') in PROBE and PROBE[node['format']] in node):
                continue
            body = _body(node)
            text = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
            digest = hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()
            size = _units(json.dumps(body, separators=(',', ':'), ensure_ascii=False))
            row = Payload.objects.filter(board_id=board.pk, node_id=node['id']).first()
            if row is None:
                row = Payload(board_id=board.pk, node_id=node['id'], rev=1, updated_at=board.updated_at)
            elif row.digest != digest:
                row.rev += 1
            row.kind, row.body, row.digest, row.size = node['format'], body, digest, size
            row.save()
            if node.get('payload') == {'size': size, 'rev': row.rev}:
                continue
            node['payload'] = {'size': size, 'rev': row.rev}
            changed = True
        if changed:
            Board.objects.filter(pk=board.pk).update(data=board.data)


def inline_payloads(apps, schema_editor):
    Board, Payload = apps.get_model('canvas', 'CanvasBoard'), apps.get_model('canvas', 'BoardFormatPayload')
    for board in Board.objects.filter(data__nodes__contains=[{'type': 'format'}]).iterator(chunk_size=50):
        nodes = board.data.get('nodes') if isinstance(board.data, dict) else None
        if not isinstance(nodes, list):
            continue
        held = [node for node in nodes if isinstance(node, dict) and node.get('type') == 'format' and node.get('format') in PROBE and 'payload' in node]
        if not held:
            continue
        rows = dict(Payload.objects.filter(board_id=board.pk, node_id__in=[node['id'] for node in held]).values_list('node_id', 'body'))
        for node in held:
            node.pop('payload')
            if PROBE[node['format']] in node:
                continue
            body = rows.get(node['id'], {})
            node[PROBE[node['format']]] = body.get(PROBE[node['format']], [] if node['format'] == 'doc' else '')
            for field in FIELDS[node['format']][1:]:
                if body.get(field):
                    node[field] = body[field]
        Board.objects.filter(pk=board.pk).update(data=board.data)


class Migration(migrations.Migration):
    dependencies = [('canvas', '0018_boardcaption')]
    operations = [
        migrations.CreateModel(
            name='BoardFormatPayload',
            fields=[
                ('id', models.UUIDField(primary_key=True, serialize=False, db_default=django.contrib.postgres.functions.RandomUUID())),
                ('board', models.ForeignKey(to='canvas.canvasboard', on_delete=django.db.models.deletion.CASCADE, db_index=False)),
                ('node_id', models.TextField()), ('kind', models.TextField()), ('body', models.JSONField()),
                ('digest', models.TextField()), ('size', models.IntegerField()), ('rev', models.IntegerField()),
                ('updated_by', models.TextField(null=True)), ('updated_at', models.BigIntegerField()),
            ], options={'db_table': 'canvas_board_format_payloads',
                'constraints': [models.UniqueConstraint(fields=['board', 'node_id'], name='canvas_format_payload_node_uniq'),
                    models.CheckConstraint(condition=models.Q(kind__in=('doc', 'html', 'drawio')), name='canvas_format_payload_kind_check')]},
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_board_format_payloads TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON canvas_board_format_payloads TO goal4_green_history_writer;
    END IF;
END $$;
""", migrations.RunSQL.noop),
        migrations.RunPython(move_payloads, inline_payloads),
    ]
