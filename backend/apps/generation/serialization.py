"""Current rowToItem public shape; provider_responses is never exposed."""
from uuid import UUID
import re

REQUIRED = ('id', 'kind', 'status', 'prompt', 'model', 'aspect_ratio',
            'depth_reap_attempts', 'is_favorite', 'flagged', 'created_at', 'updated_at')
OPTIONAL = ('resolution', 'duration', 'url', 'poster', 'reference_images', 'reference_videos',
    'reference_audios', 'error', 'moderation_blocked', 'task_id', 'submitted_at',
    'provider_created_at', 'provider_updated_at', 'completed_at', 'last_poll_at', 'next_poll_at',
    'callback_received_at', 'provider_status', 'worker_lease_id', 'worker_lease_until',
    'last_poll_error_at', 'generate_audio', 'draft_mode', 'bitrate_mode', 'video_task_mode',
    'progress_percent', 'progress_message', 'track_characters', 'depth_claim_id',
    'depth_claim_worker_id', 'project_id', 'folder_id', 'user_id', 'cost_cents', 'seed',
    'candidate_task_ids', 'continuation_frame_url', 'last_frame_url', 'favorited_at',
    'flagged_at', 'flag_reason', 'judge_score')


def camel(name):
    first, *rest = name.split('_')
    return first + ''.join(part.title() for part in rest)


def value(row, name):
    result = getattr(row, name)
    return str(result) if isinstance(result, UUID) else result


def generation_item(row):
    result = {camel(name): value(row, name) for name in REQUIRED}
    for name in OPTIONAL:
        item = value(row, name)
        if item is not None:
            result[camel(name)] = public_error(row, item) if name == 'error' else item
    for name in ('source_generation_id', 'draft_task_id'):
        result[camel(name)] = value(row, name)
    for name, fallback in [('poll_attempts', 0), ('poll_error_count', 0), ('location_version', 1)]:
        item = value(row, name)
        result[camel(name)] = fallback if item is None else item
    result['costBasis'] = 'reconciled' if row.cost_basis == 'reconciled' else 'estimated'
    if row.continuation_frame_url is not None:
        result['firstFrameUrl'] = row.continuation_frame_url
    # Magnific upscales reopen and regenerate with their exact validated parameters.
    if row.model.startswith('Magnific ') and isinstance(row.submission_input, dict) and isinstance(row.submission_input.get('params'), dict):
        result['upscaleParams'] = row.submission_input['params']
    return result


def public_error(row, diagnostic):
    """Provider/transport diagnostics are private, including historical rows.

    A provider can echo credentials in any spelling, so pattern redaction cannot
    establish a safe public message. Only exact backend messages are retained.
    """
    from .providers.seedance import MODERATION_MESSAGE
    if diagnostic == MODERATION_MESSAGE:
        return MODERATION_MESSAGE
    if row.moderation_blocked:
        return 'Generation was blocked by provider moderation. Adjust the prompt or references.'
    if isinstance(diagnostic, str) and re.fullmatch(
            r'Generation exceeded the [0-9]{1,5}-second internal deadline\.', diagnostic):
        return diagnostic
    if diagnostic in (
        'Provider reported success but returned no video.',
        'Omni reported success but returned no video.',
        'All candidates failed to generate.',
    ):
        return diagnostic
    if row.model.startswith('Magnific '):
        from .services.poller import MAGNIFIC_SAVE_FAILED, MAGNIFIC_TOO_LARGE
        from .services.upscale_submission import UPSCALE_REJECTED, UPSCALE_PREPARE_FAILED
        if diagnostic in (MAGNIFIC_TOO_LARGE, MAGNIFIC_SAVE_FAILED, UPSCALE_REJECTED, UPSCALE_PREPARE_FAILED):
            return diagnostic
        return 'Upscale generation failed.'
    if row.kind == 'audio':
        return 'Audio transcription failed.'
    if row.kind == 'depth':
        return 'Depth generation failed.'
    return 'Video generation failed.' if row.kind == 'video' else 'Image generation failed.'
