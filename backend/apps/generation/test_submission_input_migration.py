"""Fresh/upgrade proof for additive private submission inputs."""
from uuid import uuid4
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class SubmissionInputMigrationTests(TransactionTestCase):
    def test_upgrade_preserves_legacy_rows_and_nullable_private_inputs(self):
        executor=MigrationExecutor(connection)
        final=executor.loader.graph.leaf_nodes()
        previous=[node for node in final if node[0]!='generation']+[('generation','0001_railway_v2_generation')]
        identifier=uuid4()
        try:
            executor.migrate(previous)
            old=executor.loader.project_state(previous).apps.get_model('generation','Generation')
            old.objects.create(id=identifier,kind='image',status='succeeded',prompt='legacy',model='fixture',
                aspect_ratio='1:1',url='/api/media/generations/original.mov',created_at=1,updated_at=2)
            executor=MigrationExecutor(connection)
            plan=executor.migration_plan(final)
            self.assertEqual([(m.app_label,m.name) for m,backward in plan],[('generation','0002_generation_submission_input')])
            executor.migrate(final)
            from .models import Generation
            row=Generation.objects.get(pk=identifier)
            self.assertIsNone(row.submission_input)
            self.assertEqual((row.prompt,row.url,row.created_at,row.updated_at),
                ('legacy','/api/media/generations/original.mov',1,2))
            row.submission_input={'version':1,'params':{'scaleFactor':'4x'}}
            row.save(update_fields=['submission_input'])
            connection.close()
            row=Generation.objects.get(pk=identifier)
            self.assertEqual(row.submission_input,{'version':1,'params':{'scaleFactor':'4x'}})
            from .serialization import generation_item
            self.assertNotIn('submissionInput',generation_item(row))
            self.assertNotIn('submission_input',generation_item(row))
            self.assertFalse(MigrationExecutor(connection).migration_plan(final))
        finally:
            MigrationExecutor(connection).migrate(final)
