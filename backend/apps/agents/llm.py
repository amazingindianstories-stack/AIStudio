"""Gemini endpoints and the board text transport; no automatic retries of billed calls."""
from urllib.parse import quote
from apps.integrations.transport import HttpTransport, ProviderError

API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
DEFAULT_MODEL = 'gemini-flash-latest'
# The stronger model board "Create with AI" text jobs run on with advanced processing.
DEFAULT_ADVANCED_MODEL = 'gemini-pro-latest'
IMAGE_MIME = frozenset(('image/jpeg', 'image/png', 'image/webp', 'image/gif'))
# A model turn may echo Gemini's own thought metadata next to its text or functionCall part.
PART_METADATA = frozenset(('thoughtSignature', 'thought'))


def agent_model(env):
    return env.get('AGENT_LLM_MODEL') or DEFAULT_MODEL


def advanced_agent_model(env):
    return env.get('AGENT_LLM_MODEL_ADVANCED') or DEFAULT_ADVANCED_MODEL


def agent_endpoint(model):
    return API_ROOT + '/models/' + quote(model, safe='') + ':generateContent'


def board_payload_allowed(body):
    """Only a board "Create with AI" text request: one board format's exact system prompt, response schema,
    generation config and tools, text-only user/model turns, bounded size (``apps.agents.board``)."""
    from .board import body_format
    return body_format(body) is not None


class BoardTextTransport(HttpTransport):
    """A board text job's one provider call: POST generateContent on the job's Gemini model with a board-shaped body.

    Unlike the Agents tab's model calls (``loop_llm.AgentLoopTransport``), a board job is a generation row, so this transport is NOT exempt from the paid guard: with
    the guard on, the POST must also be the job's claimed, quoted request (``paid_guard.text_payload_matches``)."""

    def __init__(self, model, *, timeout=90):
        super().__init__(allowed_hosts={'generativelanguage.googleapis.com'}, timeout=timeout)
        self.endpoint = agent_endpoint(model)

    def request(self, method, url, *, headers=None, body=None, raw_body=None, signal=None):
        if method != 'POST' or url != self.endpoint or raw_body is not None or not board_payload_allowed(body):
            raise ProviderError('Board AI request is outside its allowlist.', code='agent_scope', may_have_submitted=False)
        return super().request(method, url, headers=headers, body=body, signal=signal)
