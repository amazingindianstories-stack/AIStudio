from unittest.mock import patch
from django.test import TransactionTestCase
from apps.admin_dashboard import tests as session_fixtures


class UpdateEndpointTests(TransactionTestCase):
    cookie = session_fixtures.SettingsTests.cookie
    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)

    def test_auth_precedes_selection(self):
        with patch('apps.generation.updates.read_generation_updates') as select:
            response = self.client.get('/api/history/updates?since=invalid')
            self.assertEqual((response.status_code,response.json()),(401,{'error':'UNAUTHENTICATED'}))
            select.assert_not_called()

    def test_first_watermark_fallback_server_clock_and_renewal(self):
        # The separate full-schema PG16 probe qualifies actual query selection;
        # here its boundary is replaced to inspect route parsing/timestamps.
        with patch('apps.generation.updates.time.time',return_value=1700000000), patch('apps.generation.updates.read_generation_updates',return_value=([],None,False)) as select:
            self.cookie(age=2*86400000)
            response = self.client.get('/api/history/updates?since=0x10&since=999')
            select.assert_called_once_with(16.0, after_id=None)
            self.assertEqual(response.json(),{'items':[],'now':1700000000000,'next':{'since':1699999970000,'afterId':None},'more':False})
            self.assertIn('veevee_session',response.cookies)
            for query in ['', '?since=invalid', '?since=', '?since=0', '?since=-1']:
                select.reset_mock()
                response = self.client.get('/api/history/updates'+query)
                self.assertEqual(response.status_code,200)
                select.assert_called_once_with(1699999700000, after_id=None)

    def test_invalid_database_operands_keep_empty_failure_and_no_renewal(self):
        from django.db import DataError
        for code in ('22P02', '22003'):
            cause = Exception('synthetic database failure')
            cause.sqlstate = code
            error = DataError('synthetic wrapped failure')
            error.__cause__ = cause
            self.cookie(age=2*86400000)
            with patch('apps.generation.updates.read_generation_updates',side_effect=error):
                response = self.client.get('/api/history/updates?since=1.5')
            self.assertEqual((response.status_code,response.content),(500,b''))
            self.assertNotIn('Content-Type',response)
            self.assertNotIn('veevee_session',response.cookies)


class UpdatePaginationTests(TransactionTestCase):
    """Database-backed: no change may be skipped, whatever the volume or timing."""
    def make(self, count, updated_at, **fields):
        import uuid
        from .models import Generation
        values={'kind':'image','status':'succeeded','prompt':'p','model':'m','aspect_ratio':'1:1',**fields}
        rows=[Generation(id=uuid.uuid4(),created_at=updated_at,updated_at=updated_at,**values) for _ in range(count)]
        Generation.objects.bulk_create(rows)
        return {str(r.id) for r in rows}

    def drain(self, since, after_id=None):
        from .updates import read_generation_updates
        seen=[];pages=0
        while True:
            items,cursor,more=read_generation_updates(since,after_id=after_id)
            seen.extend(i['id'] for i in items if i['status']=='succeeded');pages+=1
            if not more:return seen,pages
            since,after_id=cursor['since'],cursor['afterId']

    def test_more_than_one_page_of_changes_is_fully_delivered(self):
        expected=set()
        for offset in range(250):
            expected|=self.make(1,1_000_000+offset)
        seen,pages=self.drain(999_999)
        self.assertEqual(set(seen),expected)
        self.assertEqual(len(seen),len(set(seen)))
        self.assertEqual(pages,3)

    def test_identical_timestamps_page_by_id_without_gaps(self):
        expected=self.make(150,2_000_000)
        seen,pages=self.drain(1_999_999)
        self.assertEqual(set(seen),expected)
        self.assertEqual(len(seen),150)
        self.assertEqual(pages,2)

    def test_late_commit_inside_lag_window_is_delivered_next_poll(self):
        from unittest.mock import patch
        from .updates import COMMIT_LAG_MS
        now=10_000_000
        self.cookie=session_fixtures.SettingsTests.cookie.__get__(self)
        session_fixtures.SettingsTests.setUp(self)
        self.cookie()
        with patch('apps.generation.updates.time.time',return_value=now/1000):
            first=self.client.get('/api/history/updates?since=9000000').json()
        self.assertEqual(first['next'],{'since':now-COMMIT_LAG_MS,'afterId':None})
        late=self.make(1,now-5_000)  # committed after the poll with an earlier clock
        with patch('apps.generation.updates.time.time',return_value=(now+3_000)/1000):
            second=self.client.get('/api/history/updates?since='+str(first['next']['since'])).json()
        self.assertTrue(late<= {i['id'] for i in second['items']})

    def test_active_rows_always_included_once(self):
        active=self.make(3,5_000,status='running')
        seen=set()
        from .updates import read_generation_updates
        items,_,_=read_generation_updates(9_999_999)
        ids=[i['id'] for i in items]
        self.assertEqual(set(ids)&active,active)
        self.assertEqual(len(ids),len(set(ids)))
