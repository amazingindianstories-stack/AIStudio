from django.db import models
from django.db.models.expressions import RawSQL
from apps.common.indexes import PostgreSQLIndex

from apps.projects.models import Project
from apps.library.models import Folder


class Generation(models.Model):
    id = models.UUIDField(primary_key=True)
    kind = models.TextField()
    status = models.TextField()
    prompt = models.TextField()
    model = models.TextField()
    aspect_ratio = models.TextField()
    resolution = models.TextField(null=True)
    duration = models.IntegerField(null=True)
    url = models.TextField(null=True)
    poster = models.TextField(null=True)
    error = models.TextField(null=True)
    provider_responses = models.JSONField(null=True)
    moderation_blocked = models.BooleanField(null=True)
    reference_images = models.JSONField(null=True)
    reference_videos = models.JSONField(null=True)
    reference_audios = models.JSONField(null=True)
    project = models.ForeignKey(Project, on_delete=models.RESTRICT, db_column='project_id', null=True)
    folder = models.ForeignKey(Folder, on_delete=models.RESTRICT, db_column='folder_id', null=True)
    user_id = models.UUIDField(null=True)
    cost_cents = models.IntegerField(default=0)
    cost_basis = models.TextField(default="estimated")
    is_favorite = models.BooleanField(default=False)
    favorited_at = models.BigIntegerField(null=True)
    task_id = models.TextField(null=True)
    source_generation_id = models.UUIDField(null=True)
    draft_task_id = models.TextField(null=True)
    submitted_at = models.BigIntegerField(null=True)
    provider_created_at = models.BigIntegerField(null=True)
    provider_updated_at = models.BigIntegerField(null=True)
    completed_at = models.BigIntegerField(null=True)
    last_poll_at = models.BigIntegerField(null=True)
    next_poll_at = models.BigIntegerField(null=True)
    poll_attempts = models.IntegerField(default=0)
    callback_received_at = models.BigIntegerField(null=True)
    provider_status = models.TextField(null=True)
    worker_lease_id = models.TextField(null=True)
    worker_lease_until = models.BigIntegerField(null=True)
    poll_error_count = models.IntegerField(default=0)
    last_poll_error_at = models.BigIntegerField(null=True)
    generate_audio = models.BooleanField(null=True)
    draft_mode = models.BooleanField(null=True)
    bitrate_mode = models.TextField(null=True)
    video_task_mode = models.TextField(null=True)
    progress_percent = models.IntegerField(null=True)
    progress_message = models.TextField(null=True)
    track_characters = models.BooleanField(null=True)
    depth_claim_id = models.UUIDField(null=True)
    depth_claim_worker_id = models.TextField(null=True)
    depth_reap_attempts = models.IntegerField(default=0)
    seed = models.IntegerField(null=True)
    candidate_task_ids = models.JSONField(null=True)
    continuation_frame_url = models.TextField(null=True)
    last_frame_url = models.TextField(null=True)
    flagged = models.BooleanField(default=False)
    flagged_at = models.BigIntegerField(null=True)
    flag_reason = models.TextField(null=True)
    judge_score = models.JSONField(null=True)
    location_version = models.IntegerField(default=1)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'generations'
        indexes = [
            PostgreSQLIndex(name='generations_created_at_idx', fields=['created_at']),
            PostgreSQLIndex(name='generations_queue_idx', fields=['status', 'kind', 'created_at']),
            PostgreSQLIndex(name='generations_project_id_idx', fields=['project']),
            PostgreSQLIndex(name='generations_folder_id_idx', fields=['folder']),
            PostgreSQLIndex(name='generations_user_created_idx', fields=['user_id', 'created_at']),
            PostgreSQLIndex(models.F('created_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_created_keyset_idx'),
            PostgreSQLIndex(models.F('project').asc(nulls_last=True), models.F('created_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_project_keyset_idx'),
            PostgreSQLIndex(models.F('folder').asc(nulls_last=True), models.F('created_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_folder_keyset_idx'),
            PostgreSQLIndex(models.F('favorited_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_favorite_keyset_idx', condition=models.Q(is_favorite=True)),
            PostgreSQLIndex(models.F('flagged_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_flagged_keyset_idx', condition=models.Q(flagged=True)),
            PostgreSQLIndex(name='generations_stale_video_poll_idx', fields=['updated_at','created_at','id'],
                condition=models.Q(RawSQL("kind = 'video' and status in ('queued', 'running') and task_id is not null", [], output_field=models.BooleanField()))),
            PostgreSQLIndex(name='generations_coordinator_due_idx', fields=['status','next_poll_at','created_at'],
                condition=models.Q(RawSQL("(kind = 'video' and status in ('queued', 'running')) or (kind = 'image' and (status = 'queued' or (status = 'running' and model like 'Magnific %%')))", [], output_field=models.BooleanField()))),
        ]
