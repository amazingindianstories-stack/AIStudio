"""Four-round Gemini tool loop and prompt design with transparent tool traces."""
from copy import deepcopy
from apps.generation.watermark import WHITESPACE
from .llm import GeminiAgentClient
from .prompts import system_prompt, DESIGN_PROMPT

DESIGN_TOOL = {'name': 'design_prompt', 'description': "Design a polished, ready-to-use image or video prompt from the user's idea and any reference images attached to this conversation turn. Call once you understand what the user wants well enough to produce something concrete.",
    'parameters': {'type': 'object', 'properties': {
        'idea': {'type': 'string', 'description': "The user's idea, restated concretely: what should be depicted, and whether it's for an image or a video."},
        'references': {'type': 'string', 'description': "Optional: how attached reference images should be used, e.g. 'match this character's face' or 'match this location's look'."}}, 'required': ['idea']}}
GENERATE_DESCRIPTION = "Submit the current prompt for real image generation. Only call this once the user has clearly asked to generate (e.g. 'generate that', 'make it') and you and they are aligned on the prompt — confirm briefly first if their ask was vague."


def tools_for_kind(kind):
    return [deepcopy(DESIGN_TOOL), {'name': 'generate_video' if kind == 'video' else 'generate_image',
        'description': GENERATE_DESCRIPTION.replace('image generation', 'video generation') if kind == 'video' else GENERATE_DESCRIPTION,
        'parameters': {'type': 'object', 'properties': {'prompt': {'type': 'string', 'description': 'The final prompt to generate, self-contained.'}}, 'required': ['prompt']}}]


def design_prompt(idea, references, images, client):
    pieces = [idea, 'Reference usage: ' + references if references else None,
        f'{len(images)} reference image(s) are attached to this message.' if images else 'No reference images are attached.']
    result = client.raw(system_prompt=DESIGN_PROMPT, contents=[{'role': 'user', 'parts': [{'text': '\n\n'.join(piece for piece in pieces if piece)}, *images]}])
    text = next((part['text'] for part in result['parts'] if isinstance(part.get('text'), str)), None)
    if not text:
        raise ValueError(f'design_prompt subagent returned no text ({result.get("finishReason") or "no candidates"}).')
    return {'prompt': text.strip(WHITESPACE)}


def dispatch_tool(name, args, images, client):
    args = args if isinstance(args, dict) else {}
    if name == 'design_prompt':
        idea = args.get('idea') if isinstance(args.get('idea'), str) else ''
        references = args.get('references') if isinstance(args.get('references'), str) else None
        result = design_prompt(idea, references, images, client)
        return {'response': {'prompt': result['prompt']}, 'trace': {'tool': name, 'args': args, 'result': result}}
    if name in ('generate_image', 'generate_video'):
        prompt = args.get('prompt').strip(WHITESPACE) if isinstance(args.get('prompt'), str) else ''
        if not prompt:
            raise ValueError(f'{name} called with an empty prompt.')
        # Generation submission remains the client's existing durable enqueue;
        # this tool only emits its intent, avoiding a duplicate billed job.
        return {'response': {'ok': True, 'prompt': prompt}, 'trace': {'tool': name, 'args': args, 'result': {'prompt': prompt}}}
    raise ValueError('Unknown tool: ' + str(name))


def run_turn(history, message, images=None, kind='image', client=None):
    client = client or GeminiAgentClient()
    images = images or []
    contents = [{'role': 'model' if item['role'] == 'assistant' else 'user', 'parts': [{'text': item['content']}]} for item in history if item['role'] != 'system']
    contents.append({'role': 'user', 'parts': [{'text': message}, *images]})
    trace = None
    for _ in range(4):
        result = client.raw(system_prompt=system_prompt(kind), contents=contents, tools=tools_for_kind(kind))
        function = next((part for part in result['parts'] if part.get('functionCall')), None)
        if function:
            call = function['functionCall']
            contents.append({'role': 'model', 'parts': [deepcopy(function)]})
            try:
                dispatched = dispatch_tool(call.get('name'), call.get('args'), images, client)
                response, trace = dispatched['response'], dispatched['trace']
            except Exception:
                # Tool failures may contain signing URLs or credentials. They
                # must not be forwarded to the model or echoed in its reply.
                response = {'error': 'Tool failed.'}
            contents.append({'role': 'user', 'parts': [{'functionResponse': {'name': call.get('name'), 'response': response}}]})
            continue
        text = next((part['text'] for part in result['parts'] if isinstance(part.get('text'), str)), None)
        if text:
            return {'reply': text, 'toolTrace': trace}
        raise ValueError(f'Orchestrator returned nothing usable ({result.get("finishReason") or "no candidates"}).')
    raise ValueError('Orchestrator exceeded the tool-call round limit without a final reply.')
