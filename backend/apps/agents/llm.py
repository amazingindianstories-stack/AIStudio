"""Gemini agent transport; no automatic retries of billed calls."""
import os
from urllib.parse import quote
from apps.generation.providers.transport import HttpTransport

API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'


class GeminiAgentClient:
    def __init__(self, transport=None, *, env=None, mock=None):
        self.env = os.environ if env is None else env
        self.transport = transport or HttpTransport(allowed_hosts={'generativelanguage.googleapis.com'}, timeout=60)
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
        chosen = model or self.env.get('AGENT_LLM_MODEL') or 'gemini-flash-latest'
        response = self.transport.request('POST', API_ROOT + '/models/' + quote(chosen, safe='') + ':generateContent',
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
