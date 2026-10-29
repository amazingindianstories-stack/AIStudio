"""Milestone 3: the read tools (list_models, search_generations, get_download_links, list_folders), the resources and
the prompts, over both protocol eras, plus the opt-in extensions to the shared library read."""
import base64
import io
import json
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

from django.test import override_settings
from mcp.shared.exceptions import MCPError
from PIL import Image

from apps.admin_dashboard.models import Pricing
from apps.authentication.session import sign_session
from apps.common.leases import now_ms
from apps.common.models import ActivityLog
from apps.generation.models import Generation
from apps.library.models import Folder
from apps.mcp import catalog
from apps.mcp.tools.library import FOLDERS_OUTPUT, LINKS_OUTPUT, SEARCH_OUTPUT
from apps.mcp.tools.models import CATALOGUE_SCHEMA
from apps.projects.models import Project
from .support import ERAS, McpCase
from .test_results import StorageMixin, granted_key, mov_bytes, png_bytes

FLAGS = dict(VEEVEE_KLING=False, VEEVEE_OMNIHUMAN=True, VEEVEE_GEMINI_OMNI=True, VEEVEE_MAGNIFIC_UPSCALE=True)
DAY = 86_400_000


def leaf(error):
    """The first real error inside the exception groups the SDK client raises through."""
    while hasattr(error, 'exceptions'):
        error = error.exceptions[0]
    return error


def iso_ms(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Library(StorageMixin, McpCase):
    """A small library: a project with Campaign/Hero shots/Close-ups, a global folder and assorted generations."""

    def setUp(self):
        super().setUp()
        self.use_storage()
        self.raw = self.token()
        catalog.forget_typical()
        self.addCleanup(catalog.forget_typical)
        self.project = Project.objects.create(name='Winter', created_at=1, updated_at=1)
        self.campaign = Folder.objects.create(project=self.project, name='Campaign', created_at=1)
        self.hero = Folder.objects.create(project=self.project, parent=self.campaign, name='Hero shots', created_at=2)
        self.close = Folder.objects.create(project=self.project, parent=self.hero, name='Close-ups', created_at=3)
        self.loose = Folder.objects.create(name='Moodboard', created_at=4)
        self.clock = 1_793_000_000_000

    def row(self, **fields):
        self.clock += 1000
        values = dict(id=uuid.uuid4(), kind='image', status='succeeded', prompt='red fox in snow', model='Nano Banana 2.1',
                      aspect_ratio='16:9', resolution='2K', user_id=self.user.id, cost_cents=6, created_at=self.clock,
                      updated_at=self.clock, completed_at=self.clock + 5000)
        values.update(fields)
        return Generation.objects.create(**values)

    def image(self, name, **fields):
        identifier = uuid.uuid4()
        return self.row(id=identifier, url=self.store(f'generations/{identifier}.png', png_bytes(), 'image/png'),
                        permanent_name=name, **fields)


@override_settings(**FLAGS)
class ListModelsTests(Library):
    def models(self, mode='legacy'):
        result = self.call(self.raw, 'list_models', {}, mode)
        self.assert_structured(result, CATALOGUE_SCHEMA)
        return {model['id']: model for model in result.structured_content['models']}

    def test_only_available_models_with_registry_inputs_and_defaults(self):
        for era in ERAS:
            with self.subTest(era=era):
                models = self.models(era)
                self.assertNotIn('kling-image-3', models)                # switched off
                self.assertNotIn('nano-banana-2', models)                # not offered
                self.assertNotIn('gemini-omni-flash', models)            # retired
                self.assertNotIn('depth-anything-local', models)         # no agent tool runs depth
                self.assertIn('magnific-video-topaz', models)
                banana = models['nano-banana-2-1']
                self.assertEqual((banana['kind'], banana['tool'], banana['provider'], banana['cancel']),
                                 ('image', 'generate_image', 'Google Gemini', 'none'))
                self.assertEqual(banana['inputs']['aspectRatio']['default'], '1:1')
                self.assertEqual(banana['inputs']['resolution'], {'enum': ['1K', '2K', '4K'], 'default': '1K'})
                self.assertEqual((banana['inputs']['seed'], banana['inputs']['maxReferenceImages']), (True, 14))
                self.assertEqual(models['seedream-5-pro']['inputs']['resolution']['default'], '2K')
                seedance = models['seedance-25']['inputs']
                self.assertEqual((seedance['resolution']['default'], seedance['durationSeconds']['default'],
                                  seedance['generateAudio']['default'], seedance['draft']['default'],
                                  seedance['bitrateMode']['default'], seedance['mode']['default']),
                                 ('1080p', 5, True, False, 'high', 'generate'))
                self.assertEqual((seedance['durationSeconds']['min'], seedance['durationSeconds']['max']), (4, 30))
                self.assertEqual(models['seedance-25']['cancel'], 'queued_only')
                omni = models['gemini-omni-1-1-flash']
                self.assertEqual((omni['inputs']['resolution']['default'], omni['inputs']['durationSeconds']['default'],
                                  omni['cancel']), ('720p', 6, 'until_finished'))
                human = models['omnihuman-2']['inputs']
                self.assertTrue(human['durationSeconds']['inputDriven'])
                self.assertIsNone(human['durationSeconds']['default'])
                self.assertEqual(models['magnific-video-topaz']['inputs']['media'], 'video')
                self.assertEqual(set(models['magnific-video-topaz']['inputs']['params']),
                                 {'resolution', 'enhancementModel', 'targetFps', 'frameInterpolation', 'noise'})
                self.assertEqual(models['magnific-precision-v1']['inputs']['media'], 'image')

    def test_prices_are_read_live_and_priced_like_the_web(self):
        models = self.models()
        self.assertEqual(models['nano-banana-2-1']['price']['examples'],
                         [{'resolution': '1K', 'cents': 4}, {'resolution': '2K', 'cents': 6}, {'resolution': '4K', 'cents': 12}])
        # Seedance 2.5 lists what agents are quoted: at least the current token estimate, not the web placeholder ($0.98).
        self.assertEqual([example['cents'] for example in models['seedance-25']['price']['examples']], [53, 147, 506])
        self.assertEqual(models['seedance-25']['price']['examples'][2],
                         {'resolution': '1080p', 'durationSeconds': 5, 'generateAudio': True, 'cents': 506})
        self.assertIn('Not priced yet', models['omnihuman-2']['price']['note'])
        Pricing.objects.filter(model='Nano Banana 2.1').update(unit_cost_cents=10)
        self.assertEqual(self.models()['nano-banana-2-1']['price']['examples'][0], {'resolution': '1K', 'cents': 10})

    def test_typical_seconds_are_measured_and_cached(self):
        self.assertIsNone(self.models()['seedance-25']['typicalSeconds'])
        now = now_ms()
        for seconds in (40, 50, 60, 70, 200):
            self.row(kind='video', model='Seedance 2.5', created_at=now - 3_600_000, submitted_at=now - 3_600_000,
                     completed_at=now - 3_600_000 + seconds * 1000)
        self.row(kind='video', model='Seedance 2.5', submitted_at=now - 9 * DAY, completed_at=now - 8 * DAY)   # too old
        self.row(kind='video', model='Seedance 2.5', status='failed', submitted_at=now - 1000, completed_at=now)
        self.row(model='Nano Banana 2.1', created_at=now - 20_000, completed_at=now)                        # no submission time
        self.assertIsNone(self.models()['seedance-25']['typicalSeconds'])                                     # cached
        catalog.forget_typical()
        models = self.models()
        self.assertEqual(models['seedance-25']['typicalSeconds'], [60, 148])
        self.assertEqual(models['nano-banana-2-1']['typicalSeconds'], [20, 20])

    @override_settings(VEEVEE_MAGNIFIC_UPSCALE=False, VEEVEE_KLING=True)
    def test_flags_change_the_list(self):
        models = self.models()
        self.assertIn('kling-image-3', models)
        self.assertFalse([model for model in models.values() if model['kind'] == 'upscale'])


class SearchTests(Library):
    def search(self, mode='legacy', **arguments):
        result = self.call(self.raw, 'search_generations', arguments, mode)
        if not result.is_error:
            self.assert_structured(result, SEARCH_OUTPUT)
        return result

    def ids(self, result):
        return [item['id'] for item in result.structured_content['items']]

    def test_name_search_is_opt_in_and_the_web_still_searches_prompts_only(self):
        named = self.image('SHOT_014', prompt='a quiet lake')
        prompted = self.image('FOX_001', prompt='shot_014 of the fox')
        self.image('OTHER_002', prompt='mountains')
        for era in ERAS:
            with self.subTest(era=era):
                result = self.search(era, text='shot_014')
                self.assertEqual(self.ids(result), [str(prompted.id), str(named.id)])
                self.assertEqual(result.structured_content['total'], 2)
        self.assertEqual(self.ids(self.search(text='50%')), [])                     # escaped, not a wildcard
        self.client.cookies['veevee_session'] = sign_session(self.user)
        web = self.client.get('/api/history', {'q': 'shot_014'}).json()
        self.assertEqual([item['id'] for item in web['items']], [str(prompted.id)])

    def test_summary_items_carry_only_the_thumbnail(self):
        row = self.image('SHOT_001', folder=self.hero, project=self.project)
        item, = self.search(text='SHOT_001').structured_content['items']
        self.assertNotIn('references', item)
        self.assertEqual(item['location']['folderPath'], 'Campaign/Hero shots')
        output, = item['outputs']
        self.assertEqual(list(output['urls']), ['thumbnail'])
        self.assertEqual(granted_key(output['urls']['thumbnail']), f'thumbs/512/generations/{row.id}.png.webp')
        self.assertIsNone(output['bytes'])

    def test_subfolders_are_opt_in_and_totals_come_from_sql(self):
        top = self.row(folder=self.campaign, project=self.project)
        middle = self.row(folder=self.hero, project=self.project)
        deep = [self.row(folder=self.close, project=self.project) for _ in range(3)]
        self.row(folder=self.loose)
        self.assertEqual(self.ids(self.search(folderId=str(self.campaign.id))), [str(top.id)])
        result = self.search(folderId=str(self.campaign.id), includeSubfolders=True, limit=2)
        body = result.structured_content
        self.assertEqual((len(body['items']), body['total']), (2, 5))
        seen = self.ids(result)
        while body['nextCursor']:
            result = self.search(folderId=str(self.campaign.id), includeSubfolders=True, limit=2, cursor=body['nextCursor'])
            body = result.structured_content
            self.assertEqual(body['total'], 5)
            seen += self.ids(result)
        self.assertEqual(seen, [str(row.id) for row in reversed([top, middle, *deep])])

    def test_cursor_from_another_query_is_refused(self):
        for _ in range(3):
            self.row()
        cursor = self.search(limit=1).structured_content['nextCursor']
        self.assertTrue(cursor.startswith('v1:'))
        self.assert_tool_error(self.search(limit=1, cursor=cursor, kind='video'), 'INVALID_INPUT')
        self.assertEqual(len(self.ids(self.search(limit=1, cursor=cursor))), 1)

    def test_subtree_cap(self):
        parent = self.campaign
        with patch('apps.generation.services.reads.MAX_SUBTREE_FOLDERS', 2):
            for index in range(3):
                Folder.objects.create(project=self.project, parent=parent, name=f'Sub {index}', created_at=10 + index)
            message = self.assert_tool_error(self.search(folderId=str(parent.id), includeSubfolders=True), 'INVALID_INPUT')['message']
        self.assertIn('more than 2 subfolders', message)

    def test_filters_map_onto_the_library_filters(self):
        mine = self.row(kind='video', model='Seedance 2.5', draft_mode=True, resolution='480p', status='running')
        theirs = self.row(kind='video', model='Seedance 2.5', draft_mode=False, user_id=self.admin.id, resolution='1080p')
        depth = self.row(kind='depth', model='Depth Anything (Local)')
        audio = self.row(kind='audio', model='Seedance 2.5')
        favorite = self.row(is_favorite=True, favorited_at=self.clock)
        self.assertEqual(self.ids(self.search(createdBy='me', kind='video')), [str(mine.id)])
        self.assertEqual(self.ids(self.search(stage='final')), [str(theirs.id)])
        self.assertEqual(self.ids(self.search(model=['seedance-25'], status=['creating'])), [str(mine.id)])
        self.assertEqual(self.ids(self.search(resolution='1080p')), [str(theirs.id)])
        self.assertEqual(self.ids(self.search(kind='depth')), [str(depth.id)])
        self.assertEqual(self.ids(self.search(kind='audio')), [str(audio.id)])
        self.assertNotIn(str(audio.id), self.ids(self.search()))
        self.assertEqual(self.ids(self.search(favorite=True, sort='favorited')), [str(favorite.id)])
        self.assertEqual(self.ids(self.search(createdAfter=iso_ms(theirs.created_at), createdBefore=iso_ms(depth.created_at))),
                         [str(theirs.id)])
        self.assertEqual(self.ids(self.search(sort='oldest', limit=1)), [str(mine.id)])
        self.assertEqual(self.search(projectId='global', folderId='unsorted').structured_content['total'], 4)

    def test_invalid_inputs(self):
        self.assert_tool_error(self.search(sort='favorited'), 'INVALID_INPUT')
        self.assert_tool_error(self.search(createdAfter='yesterday'), 'INVALID_INPUT')
        self.assert_tool_error(self.search(limit=51), 'INVALID_INPUT')
        self.assert_tool_error(self.search(favorite=False), 'INVALID_INPUT')
        self.assert_tool_error(self.search(folderId='not-a-folder'), 'INVALID_INPUT')


class DownloadLinkTests(Library):
    def test_batch_with_per_item_errors_in_both_eras(self):
        ready = self.image('FOX_013')
        identifier = uuid.uuid4()
        master = mov_bytes()
        video = self.row(id=identifier, kind='video', model='Seedance 2.5', permanent_name='CLIP_001',
                         url=self.store(f'generations/{identifier}.mov', master, 'video/quicktime'))
        running = self.row(status='running', completed_at=None)
        failed = self.row(status='failed', error='Provider rejected the prompt.')
        missing = uuid.uuid4()
        ids = [str(ready.id), str(video.id).upper(), str(running.id), str(failed.id), str(missing), str(ready.id)]
        for era in ERAS:
            with self.subTest(era=era):
                result = self.call(self.raw, 'get_download_links', {'ids': ids, 'variants': ['poster', 'original']}, era)
                self.assert_structured(result, LINKS_OUTPUT)
                items = result.structured_content['items']
                self.assertEqual([item['id'] for item in items], [str(ready.id), str(video.id), str(running.id), str(failed.id), str(missing)])
                image_output, = items[0]['outputs']
                self.assertEqual(list(image_output['urls']), ['original', 'poster'])
                self.assertEqual(granted_key(image_output['urls']['original']), f'generations/{ready.id}.png')
                self.assertIsNone(image_output['urls']['poster'])
                self.assertEqual((image_output['filename'], image_output['width'], image_output['bytes']),
                                 ('FOX_013.png', 600, len(png_bytes())))
                video_output, = items[1]['outputs']
                self.assertEqual((video_output['filename'], video_output['mimeType'], video_output['bytes']),
                                 ('CLIP_001.mov', 'video/quicktime', len(master)))
                self.assertEqual(granted_key(video_output['urls']['poster']), f'thumbs/poster/generations/{identifier}.mov.webp')
                self.assertEqual([item['error']['code'] for item in items[2:]], ['NO_OUTPUT', 'NO_OUTPUT', 'NOT_FOUND'])
                self.assertEqual(result.content[0].text.split('\n')[0], 'Fresh links for 2 of 5 generations.')

    def test_default_variants_and_limits(self):
        ready = self.image('FOX_013')
        output, = self.call(self.raw, 'get_download_links', {'ids': [str(ready.id)]}).structured_content['items'][0]['outputs']
        self.assertEqual(list(output['urls']), ['original', 'thumbnail'])
        self.assert_tool_error(self.call(self.raw, 'get_download_links', {'ids': [str(uuid.uuid4()) for _ in range(51)]}),
                               'INVALID_INPUT')
        self.assert_tool_error(self.call(self.raw, 'get_download_links', {'ids': []}), 'INVALID_INPUT')


class FolderTests(Library):
    def folders(self, mode='legacy', **arguments):
        result = self.call(self.raw, 'list_folders', arguments, mode)
        if not result.is_error:
            self.assert_structured(result, FOLDERS_OUTPUT)
        return result

    def test_tree_with_sql_counts_in_both_eras(self):
        self.row(project=self.project)
        self.row(project=self.project, folder=self.campaign)
        for _ in range(2):
            self.row(project=self.project, folder=self.close)
        self.row(project=self.project, folder=self.close, kind='audio')
        self.row(folder=self.loose)
        self.row()
        for era in ERAS:
            with self.subTest(era=era):
                body = self.folders(era).structured_content
                self.assertEqual({key: body['global'][key] for key in ('name', 'itemCount', 'unsortedCount')},
                                 {'name': 'Global library', 'itemCount': 2, 'unsortedCount': 1})
                self.assertEqual([folder['name'] for folder in body['global']['folders']], ['Moodboard'])
                project, = body['projects']
                self.assertEqual((project['id'], project['name'], project['itemCount'], project['unsortedCount']),
                                 (str(self.project.id), 'Winter', 4, 1))
                campaign, = project['folders']
                hero, = campaign['children']
                close, = hero['children']
                self.assertEqual([(node['path'], node['itemCount'], node['totalCount']) for node in (campaign, hero, close)],
                                 [('Campaign', 1, 3), ('Campaign/Hero shots', 0, 2), ('Campaign/Hero shots/Close-ups', 2, 2)])

    def test_depth_and_project_filters(self):
        project = self.folders(projectId=str(self.project.id), depth=1).structured_content
        self.assertIsNone(project['global'])
        campaign, = project['projects'][0]['folders']
        self.assertEqual((campaign['children'], campaign['childrenOmitted']), ([], True))
        only_global = self.folders(projectId='global').structured_content
        self.assertEqual(only_global['projects'], [])
        self.assert_tool_error(self.folders(projectId=str(uuid.uuid4())), 'NOT_FOUND')

    def test_reading_folders_never_creates_a_project(self):
        Generation.objects.all().delete()
        Folder.objects.all().delete()
        Project.objects.all().delete()
        body = self.folders().structured_content
        self.assertEqual((body['projects'], Project.objects.count()), ([], 0))


@override_settings(**FLAGS)
class ResourceTests(Library):
    def read(self, uri, mode='legacy', raw=None):
        return self.with_client(raw or self.raw, mode, lambda client: client.read_resource(uri))

    def test_listing_in_both_eras(self):
        async def use(client):
            return ([str(item.uri) for item in (await client.list_resources()).resources],
                    [item.uri_template for item in (await client.list_resource_templates()).resource_templates])
        for era in ERAS:
            with self.subTest(era=era):
                listed, templates = self.with_client(self.raw, era, use)
                self.assertEqual(listed, ['veevee://models', 'veevee://folder/global'])
                self.assertEqual(templates, ['veevee://generation/{id}', 'veevee://generation/{id}/thumbnail',
                                             'veevee://generation/{id}/original', 'veevee://folder/{id}',
                                             'veevee://export/{id}'])

    def test_generation_resources_match_their_tools(self):
        row = self.image('FOX_013', project=self.project, folder=self.hero)
        for era in ERAS:
            with self.subTest(era=era):
                content, = self.read(f'veevee://generation/{row.id}', era).contents
                generation = json.loads(content.text)
                self.assertEqual(content.mime_type, 'application/json')
                self.assertEqual(generation, self.call(self.raw, 'get_generation', {'id': str(row.id)}).structured_content['generation']
                                 | {'outputs': generation['outputs']})
                self.assertEqual(granted_key(generation['outputs'][0]['urls']['original']), f'generations/{row.id}.png')
                blob, = self.read(f'veevee://generation/{row.id}/thumbnail', era).contents
                self.assertEqual(blob.mime_type, 'image/webp')
                with Image.open(io.BytesIO(base64.b64decode(blob.blob))) as preview:
                    self.assertEqual(preview.size, (512, 341))
                link, = self.read(f'veevee://generation/{row.id}/original', era).contents
                body = json.loads(link.text)
                self.assertEqual(set(body), {'url', 'expiresAt', 'filename', 'mimeType'})
                self.assertEqual((granted_key(body['url']), body['filename'], body['mimeType']),
                                 (f'generations/{row.id}.png', 'FOX_013.png', 'image/png'))

    def test_models_and_folder_resources(self):
        content, = self.read('veevee://models').contents
        self.assertEqual(json.loads(content.text), self.call(self.raw, 'list_models').structured_content)
        rows = [self.row(project=self.project, folder=self.campaign) for _ in range(22)]
        self.row(project=self.project, folder=self.hero)
        body = json.loads(self.read(f'veevee://folder/{self.campaign.id}').contents[0].text)
        self.assertEqual((body['folder']['path'], body['folder']['itemCount'], body['folder']['totalCount'], body['total']),
                         ('Campaign', 22, 23, 22))
        self.assertEqual([child['name'] for child in body['folder']['children']], ['Hero shots'])
        self.assertEqual([item['id'] for item in body['items']], [str(row.id) for row in reversed(rows)][:20])
        self.assertEqual(body['next']['tool'], 'search_generations')
        self.assertEqual(body['next']['arguments']['folderId'], str(self.campaign.id))
        loose = self.row()
        body = json.loads(self.read('veevee://folder/global').contents[0].text)
        self.assertEqual(([item['id'] for item in body['items']], body['next']), ([str(loose.id)], None))
        self.assertEqual([child['name'] for child in body['folder']['children']], ['Moodboard'])

    def test_unknown_or_invisible_resources_and_scopes(self):
        running = self.row(status='running', completed_at=None)
        for uri in (f'veevee://generation/{uuid.uuid4()}', f'veevee://generation/{running.id}/original',
                    f'veevee://generation/{running.id}/thumbnail', f'veevee://folder/{uuid.uuid4()}', 'veevee://nothing',
                    f'veevee://export/{uuid.uuid4()}'):
            with self.subTest(uri=uri), self.assertRaises(Exception) as caught:
                self.read(uri)
            self.assertIn('No resource', str(leaf(caught.exception)))
        organize_only = self.token(scopes=('veevee.organize',))
        with self.assertRaises(Exception) as caught:
            self.read('veevee://models', raw=organize_only)
        self.assertIn('veevee.read scope', str(leaf(caught.exception)))

    def test_reads_are_not_audited(self):
        self.read('veevee://models')
        self.assertFalse(ActivityLog.objects.filter(action='mcp_tool_call').exists())


class PromptTests(Library):
    def test_four_prompts_that_only_guide(self):
        async def use(client):
            listed = (await client.list_prompts()).prompts
            got = await client.get_prompt('seedance_draft_then_final', {'idea': 'A fox crossing a frozen lake'})
            return [prompt.name for prompt in listed], got
        for era in ERAS:
            with self.subTest(era=era):
                names, got = self.with_client(self.raw, era, use)
                self.assertEqual(names, ['storyboard_to_shots', 'seedance_draft_then_final', 'product_shot_variations',
                                         'upscale_for_delivery'])
                message, = got.messages
                self.assertEqual(message.role, 'user')
                self.assertIn('A fox crossing a frozen lake', message.content.text)
                self.assertIn('estimate_cost', message.content.text)
                self.assertIn('finalize_draft', message.content.text)
        self.assertFalse(Generation.objects.exists())
        self.assertFalse(ActivityLog.objects.filter(action='mcp_tool_call').exists())

    def test_every_prompt_renders_and_requires_its_arguments(self):
        cases = {'storyboard_to_shots': {'storyboard': 'Shot 1: dawn.'}, 'seedance_draft_then_final': {'idea': 'Dawn.'},
                 'product_shot_variations': {'product': 'A blue bottle.', 'count': '3'},
                 'upscale_for_delivery': {'selection': 'The Hero shots folder', 'target': '4K'}}

        async def use(client):
            found = {name: (await client.get_prompt(name, arguments)).messages[0].content.text for name, arguments in cases.items()}
            try:
                await client.get_prompt('storyboard_to_shots', {})
            except MCPError as error:
                found['missing'] = str(error)
            return found
        found = self.with_client(self.raw, 'legacy', use)
        self.assertIn('Make 3 product shot variations', found['product_shot_variations'])
        self.assertIn('at 4K', found['upscale_for_delivery'])
        self.assertTrue(all('estimate_cost' in text for name, text in found.items() if name != 'missing'))
        self.assertIn('needs: storyboard', found['missing'])
