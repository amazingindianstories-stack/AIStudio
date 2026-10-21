"""Worker naming namespace: Green workers allocate filename sequences privately, seeded from the canonical counter."""
from django.test import SimpleTestCase, TestCase, override_settings
from apps.common.test_leases import settings_error
from apps.library.models import NamingCounter
from apps.library.services import naming


class NamingNamespaceTests(TestCase):
    @override_settings(VEEVEE_RUNTIME_COMPONENT='generation', VEEVEE_NAMING_PREFIX='private-ns:')
    def test_private_naming_namespace_is_seeded_from_canonical_counter(self):
        NamingCounter.objects.create(namespace='project:abc', next_sequence=42, updated_at=1)
        self.assertEqual(naming.allocate_next_sequence('project:abc', now=5), 42)
        self.assertEqual(naming.allocate_next_sequence('project:abc', now=6), 43)
        self.assertEqual(NamingCounter.objects.get(namespace='project:abc').next_sequence, 42)  # canonical untouched
        private = NamingCounter.objects.get(namespace='private-ns:project:abc')
        self.assertEqual((private.next_sequence, private.updated_at), (44, 6))
        self.assertEqual(naming.allocate_next_sequence('fresh', 3, now=7), 1)
        self.assertEqual(NamingCounter.objects.get(namespace='private-ns:fresh').next_sequence, 4)
        self.assertFalse(NamingCounter.objects.filter(namespace='fresh').exists())

    def test_every_worker_component_and_only_workers_use_the_prefix(self):
        for component, namespace in (('generation', 'p-ns:a'), ('export', 'p-ns:a'), ('scheduler', 'p-ns:a'), ('api', 'a'), (None, 'a')):
            with override_settings(VEEVEE_RUNTIME_COMPONENT=component, VEEVEE_NAMING_PREFIX='p-ns:'):
                NamingCounter.objects.all().delete()
                self.assertEqual(naming.allocate_next_sequence('a', now=1), 1)
                self.assertEqual(list(NamingCounter.objects.values_list('namespace', flat=True)), [namespace], component)
        with override_settings(VEEVEE_RUNTIME_COMPONENT='generation', VEEVEE_NAMING_PREFIX=''):
            NamingCounter.objects.all().delete()
            naming.allocate_next_sequence('a', now=1)
            self.assertEqual(list(NamingCounter.objects.values_list('namespace', flat=True)), ['a'])


class NamingPrefixStartupTests(SimpleTestCase):
    def test_a_malformed_worker_naming_prefix_fails_startup(self):
        for component in ('generation', 'export', 'scheduler'):
            for prefix in ('private', 'ab:', ':'):
                error = settings_error(VEEVEE_RUNTIME_COMPONENT=component, VEEVEE_NAMING_PREFIX=prefix)
                self.assertIn('Naming prefix must end with ":"', error or '', (component, prefix))
            self.assertIsNone(settings_error(VEEVEE_RUNTIME_COMPONENT=component, VEEVEE_NAMING_PREFIX='abc:'))

    def test_the_api_never_validates_or_uses_a_naming_prefix(self):
        self.assertIsNone(settings_error(VEEVEE_RUNTIME_COMPONENT='api', VEEVEE_NAMING_PREFIX='x'))
