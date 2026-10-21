"""Read-only pre-release audit, safe against the old and expanded schema."""
import json
from django.core.management.base import BaseCommand
from django.db import connection
from apps.library.baseline_sql.permanent_names_v1 import resolve_generation_filename


class Command(BaseCommand):
    help = 'Report backfill count, legacy ZIP/download name disagreements and shared names on an approved database copy.'

    def handle(self, **options):
        with connection.cursor() as cursor:
            cursor.execute('SELECT id,parent_id,name FROM folders')
            folders = {row[0]: {'id': row[0], 'parent_id': row[1], 'name': row[2]} for row in cursor.fetchall()}
            cursor.execute('''SELECT g.id,g.folder_id,g.project_id,g.kind,g.url,n.namespace,n.sequence
                FROM generations g LEFT JOIN generation_naming n ON n.generation_id=g.id ORDER BY g.id''')
            rows = cursor.fetchall()
            disagreements = []
            current = {}
            for gid, fid, pid, kind, url, namespace, sequence in rows:
                ancestry, seen, folder = [], set(), folders.get(fid)
                while folder and folder['id'] not in seen:
                    seen.add(folder['id'])
                    ancestry.insert(0, folder)
                    folder = folders.get(folder['parent_id'])
                namespace = namespace or (f'folder:{fid}' if fid else f'project_unsorted:{pid}' if pid else 'global_unsorted')
                name = resolve_generation_filename(ancestry, namespace, sequence or 1, kind, url)
                old_leaf = resolve_generation_filename(ancestry[-1:], namespace, sequence or 1, kind, url)
                current[str(gid)] = name
                if old_leaf != name:
                    disagreements.append({'generationId': str(gid), 'downloadName': name, 'legacyZipLeaf': old_leaf})
            cursor.execute('SELECT generation_id,filename FROM media_export_items ORDER BY export_id,position')
            frozen_disagreements = [{'generationId': str(gid), 'frozenExportFilename': name, 'downloadName': current[str(gid)]}
                for gid, name in cursor.fetchall() if str(gid) in current and name.rsplit('/', 1)[-1] != current[str(gid)]]
        groups = {}
        for gid, name in current.items():
            groups.setdefault(name.rsplit('.', 1)[0].lower(), []).append(gid)
        duplicates = [{'nameKey': key, 'count': len(ids), 'generationIds': ids}
            for key, ids in sorted(groups.items()) if len(ids) > 1]
        self.stdout.write(json.dumps({'backfillRows': len(rows), 'newZipLeafChanges': disagreements,
            'existingExportDisagreements': frozen_disagreements, 'duplicateNameGroups': duplicates,
            'duplicateNameRows': sum(group['count'] for group in duplicates)}, ensure_ascii=False, sort_keys=True))
