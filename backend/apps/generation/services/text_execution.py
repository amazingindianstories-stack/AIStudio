"""Text job execution (kind 'text'): one Gemini generateContent call; the caller owns fenced DB writes.

A text job is a synchronous call like a Gemini image: no task receipt exists, so the paid guard's one-shot
ATTEMPTING->SUBMITTING claim is what stops a second billed POST. A failed or unusable 200 is billed and is never
re-submitted; only a 429/503 refusal is marked unbilled.
"""
import os

from apps.common.leases import now_ms
from apps.generation import provider_errors
from apps.integrations.errors import ProviderError
from apps.integrations.transport import required_key

# Rate limit and overload reject the request before any generation, so nothing was billed.
UNPROCESSED_STATUSES = frozenset({429, 503})


def mock_output(value):
    """MOCK_GENERATION=1 (explicit offline runs only): a fixed, valid result for the job's format."""
    from apps.agents.board import parse_output
    import json
    if value['format'] == 'stickies':
        return parse_output('stickies', json.dumps({'notes': [{'text': f'Mock idea {index}', 'color': 'yellow'} for index in (1, 2, 3)]}))
    raise ValueError('No mock result for this board format.')


def execute_text(item, *, signal, env=None, transport=None, on_task=None):
    """Return the success fields of a board text job without mutating the row."""
    from apps.agents.board import UnusableResult, build_body, is_board_input, parse_output
    from apps.agents.llm import BoardTextTransport, agent_endpoint
    env = os.environ if env is None else env
    value = item.submission_input
    if not is_board_input(value):
        raise ProviderError('This text job has no board request to run.', code='invalid_text_input', may_have_submitted=False)
    signal.check()
    if env.get('MOCK_GENERATION') == '1':
        signal.wait(300)
        return {'status': 'succeeded', 'output': mock_output(value), 'updated_at': now_ms()}
    key = required_key(env, 'GOOGLE_API_KEY')
    body = build_body(value)
    transport = transport or BoardTextTransport(value['model'])
    response = transport.request('POST', agent_endpoint(value['model']),
                                 headers={'Content-Type': 'application/json', 'x-goog-api-key': key}, body=body, signal=signal)
    if not response.ok:
        error = ProviderError(f'Gemini text error ({response.status}): {response.text[:400]}', status=response.status,
                              provider_response=provider_errors.capture('gemini', phase='create', status=response.status,
                                                                        body=response.text, headers=response.headers))
        if response.status in UNPROCESSED_STATUSES:
            error.may_have_submitted = False
            error.provider_response['unbilled'] = True
        raise error
    payload = response.json()
    candidate = (payload.get('candidates') or [{}])[0] if isinstance(payload, dict) else {}
    parts = (candidate.get('content') or {}).get('parts') or []
    # Thinking models may return thought parts first; the answer is the text part that is not a thought.
    text = next((part['text'] for part in parts if isinstance(part, dict) and isinstance(part.get('text'), str) and not part.get('thought')), None)
    try:
        if text is None:
            raise UnusableResult(f"Gemini returned no text ({candidate.get('finishReason') or 'no candidates'}).")
        output = parse_output(value['format'], text)
    except UnusableResult as error:
        # A 200 is billed; never re-submit it automatically. The reason stays in the record; the user gets the plain copy.
        from apps.generation.failure_copy import TEXT_UNUSABLE
        failure = ProviderError(TEXT_UNUSABLE, code='unusable_result', may_have_submitted=False,
                                provider_response=provider_errors.capture('gemini', phase='create', status=200, source='veevee',
                                                                          code=candidate.get('finishReason') or 'UNUSABLE_RESULT',
                                                                          message=str(error)))
        failure.terminal = True
        raise failure from None
    signal.check()
    return {'status': 'succeeded', 'output': output, 'updated_at': now_ms()}
