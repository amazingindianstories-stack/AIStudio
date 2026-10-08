from django.db import migrations
from apps.common.migration_operations.field_order import SetModelFieldOrder


class Migration(migrations.Migration):
    dependencies = [('generation', '0006_explicit_relation_index_state')]
    operations = [
        SetModelFieldOrder(name='Generation', fields=['id', 'kind', 'status', 'prompt', 'model', 'aspect_ratio', 'resolution', 'duration', 'url', 'poster', 'error', 'provider_responses', 'moderation_blocked', 'reference_images', 'reference_videos', 'reference_audios', 'project', 'folder', 'user_id', 'cost_cents', 'cost_basis', 'is_favorite', 'favorited_at', 'task_id', 'source_generation_id', 'draft_task_id', 'submitted_at', 'provider_created_at', 'provider_updated_at', 'completed_at', 'last_poll_at', 'next_poll_at', 'poll_attempts', 'callback_received_at', 'provider_status', 'worker_lease_id', 'worker_lease_until', 'poll_error_count', 'last_poll_error_at', 'generate_audio', 'draft_mode', 'bitrate_mode', 'video_task_mode', 'progress_percent', 'progress_message', 'track_characters', 'depth_claim_id', 'depth_claim_worker_id', 'depth_reap_attempts', 'seed', 'candidate_task_ids', 'continuation_frame_url', 'last_frame_url', 'flagged', 'flagged_at', 'flag_reason', 'judge_score', 'location_version', 'created_at', 'updated_at']),
    ]
