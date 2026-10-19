"""What a user is told when a generation fails.

``generations.error`` is private: it can hold provider echoes, request ids, hostnames, credentials or internal
exception text. Only two kinds of sentence leave the backend: our own curated messages (taken from the constants that
produce them, passed through verbatim) and the copy below, which classifies a diagnostic into a plain sentence
without ever repeating it.

After that sentence comes the exact provider detail, read only from the structured record in
``generations.provider_responses`` (see provider_errors): the provider's code, the field it blamed, its request id and
the task id, each validated against a strict pattern, so support can quote them to the provider.
"""
import re
from functools import lru_cache

FACE_GALLERY = ("The video provider's face filter rejected a reference image. Add the person to the Portrait Gallery "
                'and use that portrait, or use a clearly stylized reference, then try again.')
COPYRIGHT = ('The video provider stopped this video because the generated audio or video may match copyrighted '
             'material. Change the prompt, or turn off audio, and try again.')
POLICY = "The provider's content policy blocked this request. Change the prompt or references and try again."
MODERATION_BLOCKED = 'Generation was blocked by provider moderation. Change the prompt or references and try again.'
AUDIO = ('The video provider rejected a reference audio clip. Use clips between 2 and 15 seconds (30 for Edit and Extend), '
         'in a common format such as MP3 or WAV, and try again.')
BUSY = 'This model is busy or out of capacity right now. Try again in a few minutes or choose another model.'
UNAVAILABLE = "This model isn't available right now. Choose another model or try again later."
DROPPED = 'The connection to the provider dropped before the result arrived. Retry the generation.'
INTERRUPTED = 'The server was interrupted before this generation finished. Retry it.'
PORTRAIT_ASSET = ('A portrait reference could not be used by the video provider. Open it in the Portrait Gallery to '
                  'check it, or remove it from the references, then try again.')
PORTRAIT_UNREGISTERED = ("A Gallery portrait in your references isn't ready for video. Open the Portrait Gallery to "
                         'check it, or remove it, then try again.')
DRAFT = "Draft mode isn't available for this kind of request. Turn Draft off and try again."
RATIO_DURATION = ("The video provider doesn't accept this aspect ratio or duration for this kind of task. "
                  'Adjust them and try again.')
IMAGE_REJECTED = 'The image provider rejected the request. Check the reference images and the prompt, then try again.'
NO_IMAGE = 'The model did not return an image. Change the prompt or references and try again.'
NO_VIDEO = 'The provider finished but returned no video. Retry the generation.'
CLIP_PREPARE = 'A reference clip could not be prepared for the provider. Try a different clip.'
UPSCALE_FAILED = 'The upscaler could not process this file. Try different settings or another source, or retry later.'
UPSCALE_BUSY = 'The upscale service is busy right now. Nothing was charged. Try again in a few minutes.'
AUDIO_REJECTED = 'The transcription service rejected this audio. Try a different or shorter clip.'
GENERIC = {
    'video': 'Something went wrong on our side and this video stopped. Retry it; if it keeps failing, let the team know.',
    'image': 'Something went wrong on our side and this image stopped. Retry it; if it keeps failing, let the team know.',
    'audio': 'Something went wrong on our side and this transcription stopped. Retry it; if it keeps failing, let the team know.',
    'depth': 'Something went wrong on our side and this depth map stopped. Retry it; if it keeps failing, let the team know.',
    'upscale': 'Something went wrong on our side and this upscale stopped. Retry it; if it keeps failing, let the team know.',
}
AUDIO_INPUT_INVALID = 'Audio input is invalid or unavailable.'
# The provider answered with an error we have no plainer sentence for: the exact detail follows, so never "our side".
PROVIDER_ERROR = {
    'video': 'The video provider returned an error, so this video stopped.',
    'image': 'The image provider returned an error, so this image stopped.',
    'audio': 'The transcription service returned an error, so this transcription stopped.',
    'depth': 'The depth service returned an error, so this depth map stopped.',
    'upscale': 'The upscaler returned an error, so this upscale stopped.',
}

_MODEL = r'[\w .\-()]{1,60}'
# Our own templated messages (inputs are numbers, tags and model names), anchored in full.
_CURATED_PATTERNS = (
    r'Generation exceeded the [0-9]{1,5}-second internal deadline\.',
    r'Reference image could not be converted to JPEG for Seedance \(was [\w/.+\-]{1,40}\)\.',
    rf'{_MODEL} accepts (?:1|one) reference images?[,;] [^\n]{{1,400}}',
    rf'{_MODEL} cannot render 2K from a reference image [-\u2014] [^\n]{{1,300}}',
    rf'{_MODEL} accepts prompts up to 2500 characters; this one is \d{{1,6}}\. [^\n]{{1,200}}',
    rf'{_MODEL} supports [\w/]{{1,40}} only; [\w.]{{1,20}} was requested\.[^\n]{{0,100}}',
    rf'{_MODEL} does not support [\w:]{{1,10}}\. Supported: [\w:, ]{{1,200}}',
    r'Kling needs reference images at least 300px on both sides; this one is \d{1,6}×\d{1,6}\.',
    r'Kling needs a reference aspect ratio between 1:2\.5 and 2\.5:1; this one is \d{1,6}×\d{1,6}\.',
    r"The reference image is [\d.]{1,8}MB after compression; Kling's limit is 10MB\.",
    r'This prompt tags [^\n]{1,200} but no reference image is attached\. Attach the image, or remove the tag from the prompt\.',
    rf'Too many reference images: \d{{1,4}}\. {_MODEL} accepts at most \d{{1,3}} images per prompt [-\u2014] remove \d{{1,3}}\.',
    r'Seedream 5\.0 Pro requires 1K, 1\.5K, or 2K and a supported aspect ratio\.',
    r'Invalid reference images\. Upload the images again\.',
    r'Missing reference @[\w\-]{1,60}\. Attach the asset or remove its tag\.',
    r'Seedream 5\.0 Pro accepts at most 10 resolved images; this prompt resolves to \d{1,4}\. Reduce uploads or named asset images\.',
    r'Seedream accepts at most 10 references\.',
    r'Reference \d{1,3} could not be read\. Upload it again\.',
    r'Prompt is required\.',
    rf'{_MODEL} has been retired\. Choose {_MODEL} instead\.',
)


@lru_cache(maxsize=1)
def _curated():
    """Exact messages from the constants that produce them (imported lazily: this runs on every history read)."""
    from apps.assets import managed_pool
    from .image_limits import SEEDANCE_MESSAGE
    from .providers import seedance, seedream
    from .services import audio_submission, poller, portrait_prepare, seedream_references, upscale_submission, video_execution
    exact = {
        seedance.MODERATION_MESSAGE, seedance.TEXT_POLICY_MESSAGE, seedance.NEUTRAL_POLICY_MESSAGE,
        portrait_prepare.REJECTED_MESSAGE,
        seedream.AMBIGUOUS_MESSAGE, seedream.NO_RESULT_MESSAGE, seedream.DOWNLOAD_FAILED_MESSAGE,
        poller.MAGNIFIC_TOO_LARGE, poller.MAGNIFIC_IMAGE_TOO_LARGE, poller.MAGNIFIC_SAVE_FAILED,
        poller.POLL_ABANDONED, poller.DOWNLOAD_ABANDONED,
        upscale_submission.UPSCALE_REJECTED, upscale_submission.UPSCALE_PREPARE_FAILED,
        video_execution.FACE_NOT_READY, video_execution.LOOKUP_UNAVAILABLE,
        managed_pool.PORTRAIT_UNPREPARED + managed_pool.NOT_CHARGED, managed_pool.PORTRAIT_REFUSED + managed_pool.NOT_CHARGED,
        managed_pool.PORTRAIT_MISSING,
        seedream_references.CORRUPT, 'Reference is not a stored media file or secure URL.',
        'Reference dimensions must exceed 14 pixels with an aspect ratio between 1:16 and 16:1.',
        'Reference could not fit the 30 MB limit. Export a smaller PNG or JPEG.',
        'Use an uploaded or stored original image as the reference.',
        'Provider reported success but returned no video.', 'Omni reported success but returned no video.',
        'All candidates failed to generate.', AUDIO_INPUT_INVALID, *audio_submission.INVALID_INPUT_MESSAGES,
        FACE_GALLERY, COPYRIGHT, POLICY, MODERATION_BLOCKED, AUDIO, BUSY, UNAVAILABLE, DROPPED, INTERRUPTED, PORTRAIT_ASSET,
        PORTRAIT_UNREGISTERED, DRAFT, RATIO_DURATION, IMAGE_REJECTED, NO_IMAGE, NO_VIDEO, CLIP_PREPARE, UPSCALE_FAILED,
        UPSCALE_BUSY, AUDIO_REJECTED,
        *GENERIC.values(), *PROVIDER_ERROR.values(),
    }
    busy = managed_pool.PORTRAIT_BUSY.format(minutes='\0')
    patterns = [re.compile(pattern) for pattern in _CURATED_PATTERNS]
    patterns.append(re.compile(re.escape(busy).replace('\0', r'\d{1,4}')))
    patterns.append(SEEDANCE_MESSAGE)
    problems = '|'.join(re.escape(problem) for problem in video_execution.PORTRAIT_PROBLEMS)
    tail = re.escape(' ' + video_execution.PORTRAIT_REMOVE_TAIL)
    patterns.append(re.compile(rf'(?:Portrait "[^\n]{{0,80}}"|A Gallery portrait) (?:{problems})\.' + tail))
    return exact, patterns


# Diagnostics from our own stack or infrastructure: never shown, never classified as a provider problem.
INTERNAL = re.compile(r'an error occurred \(|permission denied for|is not defined|failed to parse|traceback|'
                      r'\bkeyerror\b|\battributeerror\b|\btypeerror\b|\bsql|\bdatabase\b|\barn:|\.amazonaws\.|\bs3\b|\bgcs\b', re.I)
# Ordered: the first matching rule wins.
RULES = (
    (re.compile(r'PrivacyInformation|anti-deepfake|real person|photorealistic face', re.I), 'face'),
    (re.compile(r'copyright', re.I), COPYRIGHT),
    (re.compile(r'parameter `?draft`? is not supported', re.I), DRAFT),
    (re.compile(r'parameters? `ratio` and `duration`|identified your task as video editing', re.I), RATIO_DURATION),
    (re.compile(r'audio duration|invalid audio|reference audio|audio parameter|content\[\d+\]\.audio', re.I), AUDIO),
    (re.compile(r'specified asset|image_url\.url[^\n]{0,200}asset|asset-\d', re.I), PORTRAIT_ASSET),
    (re.compile(r'not registered and Active|Register and verify the existing portrait', re.I), PORTRAIT_UNREGISTERED),
    (re.compile(r'SensitiveContent|PolicyViolation|PROHIBITED_CONTENT|content policy|text content|\bSAFETY\b', re.I), POLICY),
    (re.compile(r'^Magnific upscale was rate limited \(429\)', re.I), UPSCALE_BUSY),
    (re.compile(r'rate limit|too many requests|\bhttp 429|\(429|\b429\b[^\n]{0,20}(?:rate|limit|quota)|balance not enough|'
                r'insufficient|quota|exhausted|out of credits|code 1102|^Gemini image error \(503\)|'
                r'ServerOverloaded|RateLimitExceeded|QuotaExceeded|TooManyRequests|RequestBurstTooFast', re.I), BUSY),
    (re.compile(r'api key not valid|invalid api key|api_key_invalid|InvalidEndpointOrModel|NotFound|\(404|do not have access|'
                r'ModelNotOpen|model access failed|authentication|reauthenticat|gcloud auth|token family|no higgsfield mcp token|'
                r'unauthori[sz]ed|forbidden|is not set|\(40[13]\b', re.I), UNAVAILABLE),
    (re.compile(r'server process was interrupted', re.I), INTERRUPTED),
    (re.compile(r'timed out|timeout|connection (?:aborted|reset|ended|error|closed)|socket hang up|fetch failed|'
                r'deadline|econnreset|etimedout|enotfound|interrupted|remote end closed|broken pipe', re.I), DROPPED),
    (re.compile(r'returned no image', re.I), NO_IMAGE),
    (re.compile(r'returned no video|no output (?:video|image)', re.I), NO_VIDEO),
    (re.compile(r'^Gemini transcription failed \(4\d\d\)', re.I), AUDIO_REJECTED),
    (re.compile(r'^Seedream rejected the request', re.I), IMAGE_REJECTED),
    (re.compile(r'^Reference clip could not be prepared', re.I), CLIP_PREPARE),
)


def kind_of(row):
    if (row.model or '').startswith('Magnific '):
        return 'upscale'
    return row.kind if row.kind in GENERIC else 'image'


def _face(row):
    # The Retry promise (portrait_prepare.REJECTED_MESSAGE) is stored, and passes through, only when the missed
    # face was actually learned; any other face rejection points at the Gallery, which works in both modes.
    return FACE_GALLERY


def public_message(row, diagnostic):
    """The text safe to show for a failed generation: the plain sentence, then the exact provider detail."""
    from . import provider_errors
    sentence = _sentence(row, diagnostic)
    entry = provider_errors.primary(getattr(row, 'provider_responses', None))
    detail = provider_errors.user_detail(entry)
    if not detail:
        return sentence
    kind = kind_of(row)
    if entry.get('source') != 'veevee':
        sentence = provider_errors.policy_sentence(entry) or (PROVIDER_ERROR[kind] if sentence == GENERIC[kind] else sentence)
    return sentence + ' ' + detail


def _sentence(row, diagnostic):
    """The plain sentence for a private diagnostic (never the diagnostic itself)."""
    kind = kind_of(row)
    if not isinstance(diagnostic, str) or not diagnostic.strip():
        return GENERIC[kind]
    text = diagnostic.strip()
    exact, patterns = _curated()
    from .providers.seedance import MODERATION_MESSAGE
    if text == MODERATION_MESSAGE:
        return _face(row)
    if text in exact or any(pattern.fullmatch(text) for pattern in patterns):
        return text.replace(' \u2014 ', ' - ')      # a few provider adapters still emit one; never show it
    if not INTERNAL.search(text):
        for pattern, copy in RULES:
            if pattern.search(text):
                if copy == 'face':
                    return _face(row)
                return copy
    if row.moderation_blocked:
        return MODERATION_BLOCKED
    return UPSCALE_FAILED if kind == 'upscale' and not INTERNAL.search(text) else GENERIC[kind]

