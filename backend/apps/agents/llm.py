"""Gemini agent transport; no automatic retries of billed calls."""
import json
import os
from urllib.parse import quote
from apps.integrations.transport import HttpTransport, ProviderError

API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
DEFAULT_MODEL = 'gemini-flash-latest'
IMAGE_MIME = frozenset(('image/jpeg', 'image/png', 'image/webp', 'image/gif'))
PART_KEYS = frozenset(('text', 'inlineData', 'functionCall', 'functionResponse'))
# A model turn may echo Gemini's own thought metadata next to its text or functionCall part.
PART_METADATA = frozenset(('thoughtSignature', 'thought'))
MAX_BODY_BYTES = 24 * 1024 * 1024


def agent_model(env):
    return env.get('AGENT_LLM_MODEL') or DEFAULT_MODEL


def agent_endpoint(model):
    return API_ROOT + '/models/' + quote(model, safe='') + ':generateContent'


def agent_payload_allowed(body):
    """Only an agent chat turn: one of the agent's own system prompts with exactly its tool set, chat contents,
    no generation config."""
    from .orchestrator import tools_for_kind
    from .prompts import DESIGN_PROMPT, system_prompt
    if not isinstance(body, dict) or not {'systemInstruction', 'contents'} <= set(body) <= {'systemInstruction', 'contents', 'tools'}:
        return False
    # The chat turn of each tab carries that tab's tools; the prompt-design subcall carries none.
    calls = [(system_prompt(kind), [{'functionDeclarations': tools_for_kind(kind)}]) for kind in ('image', 'video')] + [(DESIGN_PROMPT, None)]
    if not any(body['systemInstruction'] == {'parts': [{'text': text}]} and body.get('tools') == tools for text, tools in calls):
        return False
    contents = body['contents']
    if not isinstance(contents, list) or not contents:
        return False
    for item in contents:
        if not isinstance(item, dict) or set(item) != {'role', 'parts'} or item['role'] not in ('user', 'model') or not isinstance(item['parts'], list):
            return False
        for part in item['parts']:
            if not isinstance(part, dict) or len(set(part) & PART_KEYS) != 1 or not set(part) <= PART_KEYS | PART_METADATA:
                return False
            inline = part.get('inlineData')
            if inline is not None and (not isinstance(inline, dict) or set(inline) != {'mimeType', 'data'}
                                       or inline['mimeType'] not in IMAGE_MIME or not isinstance(inline['data'], str)):
                return False
    return len(json.dumps(body, separators=(',', ':'))) <= MAX_BODY_BYTES


class AgentTransport(HttpTransport):
    """The admin chat agent's only provider call: POST generateContent on the configured agent model with an
    agent-shaped body. A chat turn is not a generation job (no row to reserve), so it is exempt from the paid
    guard and bounded by this exact allowlist instead."""
    paid_guard_exempt = True

    def __init__(self, env=None, *, timeout=60):
        super().__init__(allowed_hosts={'generativelanguage.googleapis.com'}, timeout=timeout)
        self.endpoint = agent_endpoint(agent_model(os.environ if env is None else env))

    def request(self, method, url, *, headers=None, body=None, raw_body=None, signal=None):
        if method != 'POST' or url != self.endpoint or raw_body is not None or not agent_payload_allowed(body):
            raise ProviderError('Agent request is outside its allowlist.', code='agent_scope', may_have_submitted=False)
        return super().request(method, url, headers=headers, body=body, signal=signal)


class GeminiAgentClient:
    def __init__(self, transport=None, *, env=None, mock=None):
        self.env = os.environ if env is None else env
        self.transport = transport or AgentTransport(self.env)
        self.mock = (self.env.get('MOCK_GENERATION') == '1' and transport is None) if mock is None else mock

    def raw(self, *, system_prompt, contents, tools=None, model=None):
        if self.mock:
            return {'parts': [{'text': 'I can help you develop a prompt for your scene.'}], 'finishReason': 'STOP'}
        key = self.env.get('GOOGLE_API_KEY')
        if not key:
            raise ValueError('GOOGLE_API_KEY is not set.')
        body = {'systemInstruction': {'parts': [{'text': system_prompt}]}, 'contents': contents}
        if tools:
            body['tools'] = [{'functionDeclarations': tools}]
        chosen = model or agent_model(self.env)
        response = self.transport.request('POST', agent_endpoint(chosen),
            headers={'Content-Type': 'application/json', 'x-goog-api-key': key}, body=body)
        if not response.ok:
            raise ValueError(f'Agent LLM error ({response.status}): {response.text[:400]}')
        payload = response.json()
        candidates = payload.get('candidates') or []
        candidate = candidates[0] if candidates else {}
        result = {'parts': (candidate.get('content') or {}).get('parts') or [], 'finishReason': candidate.get('finishReason')}
        usage = payload.get('usageMetadata')
        if usage:
            result['usage'] = {'tokensIn': usage.get('promptTokenCount'), 'tokensOut': usage.get('candidatesTokenCount')}
        return result

    def text(self, *, system_prompt, messages, model=None):
        contents = [{'role': 'model' if message['role'] == 'assistant' else 'user', 'parts': [{'text': message['content']}]} for message in messages if message['role'] != 'system']
        result = self.raw(system_prompt=system_prompt, contents=contents, model=model)
        part = next((part for part in result['parts'] if isinstance(part.get('text'), str)), None)
        if part is None:
            raise ValueError(f'Agent LLM returned no text ({result.get("finishReason") or "no candidates"}).')
        return {'text': part['text'], 'usage': result.get('usage')}
