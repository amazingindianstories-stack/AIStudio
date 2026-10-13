from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.http import HttpResponse
from django.test import RequestFactory
from .middleware import LocalDataModeMiddleware


class LocalDataModeTests(SimpleTestCase):
    @override_settings(LOCAL_DATA_MODE='read_only_viewer')
    def test_mutations_never_enter_domain(self):
        def domain(request):
            self.fail('viewer mutation reached domain')
        guard = LocalDataModeMiddleware(domain)
        for method in ('post', 'put', 'patch', 'delete'):
            response = guard(getattr(RequestFactory(), method)('/api/projects'))
            self.assertEqual(response.status_code, 403)

    @override_settings(LOCAL_DATA_MODE='read_only_viewer')
    def test_read_proceeds_with_safe_mode_header(self):
        response = LocalDataModeMiddleware(lambda request: HttpResponse('ok'))(RequestFactory().get('/api/health'))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['X-Veevee-Data-Mode'], 'read_only_viewer')


class ViewerDatabaseGuardTests(TransactionTestCase):
    @override_settings(LOCAL_DATA_MODE='read_only_viewer')
    def test_get_domain_cannot_write_database(self):
        from django.db import DatabaseError
        from apps.authentication.models import User
        def domain(request):
            User.objects.all().update(name='forbidden')
            return HttpResponse('unexpected')
        with self.assertRaises(DatabaseError) as caught:
            LocalDataModeMiddleware(domain)(RequestFactory().get('/api/history'))
        self.assertEqual(caught.exception.__cause__.sqlstate, '25006')
