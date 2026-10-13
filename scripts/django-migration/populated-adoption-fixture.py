"""Populate all 21 application tables before a disposable adoption snapshot.

The PG16 adoption probe executes this source after django.setup(), with its
current-source schema and invariant triggers already installed. These are
synthetic database records only: no media bytes, storage, or provider requests.
The caller receives populated_adoption_fixture_counts without logging row data.
"""


def populate_adoption_fixture():
    import os
    from uuid import UUID

    from django.apps import apps
    from django.db import connection, transaction

    from apps.authentication.password import derive
    from django.db.migrations.executor import MigrationExecutor
    executor = MigrationExecutor(connection)
    baseline_targets = [node for node in executor.loader.graph.leaf_nodes() if node[0] not in {"generation", "assets", "media"}] + [("generation", "0001_baseline_generation"), ("assets", "0003_baseline_portraitasset")]
    baseline_apps = executor.loader.project_state(baseline_targets).apps
    AppSetting = baseline_apps.get_model('admin_dashboard', 'AppSetting')
    Pricing = baseline_apps.get_model('admin_dashboard', 'Pricing')
    UserLimit = baseline_apps.get_model('admin_dashboard', 'UserLimit')
    AgentConversation = baseline_apps.get_model('agents', 'AgentConversation')
    AgentConversationMessage = baseline_apps.get_model('agents', 'AgentConversationMessage')
    Asset = baseline_apps.get_model('assets', 'Asset')
    PortraitAsset = baseline_apps.get_model('assets', 'PortraitAsset')
    PortraitGroup = baseline_apps.get_model('assets', 'PortraitGroup')
    LoginAttempt = baseline_apps.get_model('authentication', 'LoginAttempt')
    User = baseline_apps.get_model('authentication', 'User')
    CanvasBoard = baseline_apps.get_model('canvas', 'CanvasBoard')
    ActivityLog = baseline_apps.get_model('common', 'ActivityLog')
    MediaExport = baseline_apps.get_model('exports', 'MediaExport')
    MediaExportItem = baseline_apps.get_model('exports', 'MediaExportItem')
    Generation = baseline_apps.get_model('generation', 'Generation')
    Folder = baseline_apps.get_model('library', 'Folder')
    GenerationNaming = baseline_apps.get_model('library', 'GenerationNaming')
    OrganizationIdempotencyKey = baseline_apps.get_model('library', 'OrganizationIdempotencyKey')
    Project = baseline_apps.get_model('projects', 'Project')
    DepthWorker = baseline_apps.get_model('workers', 'DepthWorker')

    target = connection.settings_dict
    if (os.environ.get('VEEVEE_BASELINE_TEST') != '1'
            or not str(target.get('HOST', '')).startswith('veevee-qualification-pg-')
            or target.get('NAME') != 'veevee_django_migration'):
        raise RuntimeError('Disposable container adoption fixture target required')

    prefix = 'adoption-fixture-v1'
    now = 1791417600000

    def identifier(number):
        # Separate from the 1111..7777 identifiers in invariant-behavior.sql.
        return UUID(f'8ad07100-1000-4000-8000-{number:012d}')

    user_id, project_id = identifier(1), identifier(2)
    root_id, child_id = identifier(3), identifier(4)
    global_root_id, global_child_id = identifier(5), identifier(6)
    image_id, video_id, depth_id, global_image_id = [identifier(n) for n in range(10, 14)]
    claim_id = identifier(14)
    worker_id = prefix + '-gpu'
    models = {model._meta.db_table: model for model in baseline_apps.get_models()}
    assert len(models) == 21, 'Fixture requires the complete 21-table registry'

    with transaction.atomic():
        # Fail on accidental re-seeding rather than modifying an adopted fixture.
        assert not User.objects.filter(pk=user_id).exists(), 'Adoption fixture already populated'
        salt = 'adoption-fixture-synthetic-salt'
        user = User.objects.create(
            id=user_id, email=prefix + '@example.invalid', name='Adoption Fixture',
            password_hash=derive('synthetic-adoption-password', salt).hex(), password_salt=salt,
            created_at=now, role='user', color='blue', avatar_url=None, auth_version=3,
        )
        project = Project.objects.create(
            id=project_id, name=prefix + ' दृश्य', brief='Synthetic populated adoption brief',
            created_by=user.id, created_at=now, updated_at=now + 1,
        )
        Folder.objects.create(id=root_id, project_id=project.id, name=prefix + ' Project',
                              color='purple', created_at=now, updated_at=now + 1)
        Folder.objects.create(id=child_id, project_id=project.id, parent_id=root_id,
                              name='संदर्भ', color=None, created_at=now + 1, updated_at=now + 2)
        Folder.objects.create(id=global_root_id, name=prefix + ' Global',
                              color='green', created_at=now, updated_at=now + 1)
        Folder.objects.create(id=global_child_id, parent_id=global_root_id, name='Masters',
                              color=None, created_at=now + 1, updated_at=now + 2)

        image_key = prefix + '/image.png'
        video_key = prefix + '/master.mov'
        Generation.objects.create(
            id=image_id, kind='image', status='succeeded', prompt='Synthetic image संदर्भ',
            model='fixture-image', aspect_ratio='1:1', resolution='2K', folder_id=global_child_id,
            user_id=user.id, url='/api/media/' + image_key, is_favorite=True,
            favorited_at=now + 20, reference_images=[], reference_videos=None, reference_audios=None,
            cost_cents=12, cost_basis='estimated', completed_at=now + 10,
            created_at=now, updated_at=now + 20,
        )
        Generation.objects.create(
            id=video_id, kind='video', status='succeeded', prompt='Synthetic native MOV master',
            model='Seedance 2.5', aspect_ratio='16:9', resolution='1080p', duration=8,
            project_id=project.id, folder_id=child_id, user_id=user.id, url='/api/media/' + video_key,
            poster='/api/media/' + prefix + '/poster.png', task_id=prefix + '-video-task',
            reference_images=['/api/media/' + image_key], reference_videos=[], reference_audios=[],
            generate_audio=True, draft_mode=False, bitrate_mode='high', video_task_mode='generate',
            provider_responses=[{'fixture': True, 'output_format': 'mov',
                                 'content_type': 'video/quicktime', 'master_bytes_preserved': True}],
            cost_cents=89, cost_basis='reconciled', submitted_at=now + 1,
            provider_created_at=now + 2, provider_updated_at=now + 8, completed_at=now + 9,
            last_poll_at=now + 8, poll_attempts=2, callback_received_at=now + 9,
            provider_status='succeeded', created_at=now, updated_at=now + 9,
        )
        Generation.objects.create(
            id=depth_id, kind='depth', status='running', prompt='Synthetic depth fixture',
            model='fixture-depth', aspect_ratio='16:9', project_id=project.id, user_id=user.id,
            source_generation_id=video_id, reference_videos=['/api/media/' + video_key],
            depth_claim_id=claim_id, depth_claim_worker_id=worker_id, depth_reap_attempts=1,
            worker_lease_id=worker_id, worker_lease_until=now + 60000,
            progress_percent=25, progress_message='Synthetic processing checkpoint',
            track_characters=True, created_at=now + 10, updated_at=now + 20,
        )
        Generation.objects.create(
            id=global_image_id, kind='image', status='queued', prompt='Synthetic unsorted fixture',
            model='fixture-image', aspect_ratio='1:1', user_id=user.id,
            reference_images=None, reference_videos=None, reference_audios=None,
            created_at=now + 30, updated_at=now + 30,
        )

        Asset.objects.create(id=identifier(20), kind='character', name=prefix + ' Character',
                             slug=prefix + '-character', description='Synthetic reference catalog',
                             images=['/api/media/' + image_key], project_id=project.id,
                             created_at=now, updated_at=now + 1)
        group = PortraitGroup.objects.create(
            id=identifier(21), byteplus_group_id=prefix + '-remote-group', name='Fixture Portraits',
            project_id=project.id, primary_asset_id=prefix + '-remote-portrait',
            created_at=now, updated_at=now + 1,
        )
        PortraitAsset.objects.create(
            id=identifier(22), group=group, byteplus_asset_id=prefix + '-remote-portrait',
            name='संदर्भ', image_url='/api/media/' + image_key, status='Active',
            created_at=now, updated_at=now + 1,
        )
        AppSetting.objects.create(key=prefix + '-setting', value='4', updated_at=now)
        UserLimit.objects.create(user_id=user.id, key=prefix + '-limit', value='2', updated_at=now)
        Pricing.objects.create(model='fixture-image', unit_cost_cents=12, unit='image',
                               notes='Synthetic fixture; no provider billing')
        CanvasBoard.objects.create(
            id=identifier(23), project_id=project.id, name=prefix + ' Board', created_by=user.id,
            data={'version': 1, 'nodes': [], 'connectors': [], 'viewport': {'x': 0, 'y': 0, 'zoom': 1}},
            created_at=now, updated_at=now + 1,
        )
        conversation = AgentConversation.objects.create(
            id=identifier(24), project_id=project.id, name=prefix + ' Conversation',
            created_by=user.id, agent_kind=None, created_at=now, updated_at=now + 1,
        )
        AgentConversationMessage.objects.create(
            id=identifier(25), conversation_id=conversation.id, role='assistant',
            content='Synthetic fixture response; no LLM was called.',
            tool_trace=[{'name': 'fixture', 'result': {'generationId': str(image_id)}}], created_at=now + 1,
        )
        ActivityLog.objects.create(id=identifier(26), user_id=user.id, action='fixture_created',
                                   detail={'fixture': prefix, 'projectId': str(project.id)}, created_at=now)
        LoginAttempt.objects.create(id=identifier(27), identifier=prefix + '@example.invalid', created_at=now)
        DepthWorker.objects.create(
            id=identifier(28), worker_id=worker_id, label='Synthetic GPU', device='fixture-device',
            status='busy', current_job_id=depth_id, current_claim_id=claim_id, protocol_version=2,
            ram_limit_mb=8192, ram_used_mb=2048, last_seen_at=now + 20, created_at=now,
        )
        export = MediaExport.objects.create(
            id=identifier(29), user_id=user.id, status='ready', total_items=2, processed_items=2,
            manifest_version=2, attempt_count=1, output_key=prefix + '/frozen-export.zip',
            output_bytes=4096, warnings=[], created_at=now, updated_at=now + 30, expires_at=now + 86400000,
        )
        for position, generation_id, key, filename in [
            (0, image_id, image_key, 'Global/Masters/संदर्भ_001.png'),
            (1, video_id, video_key, 'Project/संदर्भ/scene_001.mov'),
        ]:
            MediaExportItem.objects.create(export=export, generation_id=generation_id,
                                           position=position, source_key=key, filename=filename)
        OrganizationIdempotencyKey.objects.create(
            key=prefix + '-receipt', actor_id=str(user.id), operation='createFolder',
            fingerprint=prefix + '-request-fingerprint',
            result={'folder': {'id': str(child_id), 'name': 'संदर्भ', 'color': None}},
            created_at=now, expires_at=now + 86400000,
        )

    # Commit has now fired the deferred naming/scope triggers. Require their
    # derived records instead of manufacturing fixtures that evade constraints.
    expected_namespaces = {
        image_id: 'folder:' + str(global_child_id),
        video_id: 'folder:' + str(child_id),
        depth_id: 'project_unsorted:' + str(project_id),
        global_image_id: 'global_unsorted',
    }
    for generation_id, namespace in expected_namespaces.items():
        assert GenerationNaming.objects.get(generation_id=generation_id).namespace == namespace
    counts = {table: model.objects.count() for table, model in sorted(models.items())}
    assert all(count > 0 for count in counts.values()), 'Every application table must contain a fixture'
    return counts


populated_adoption_fixture_counts = populate_adoption_fixture()
