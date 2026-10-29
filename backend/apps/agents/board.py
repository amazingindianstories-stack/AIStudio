"""Board "Create with AI" text formats: the exact Gemini request each one sends and the result it accepts.

A text format is a fixed system prompt, a fixed JSON response schema and a fixed generation config. The request body
is rebuilt from the job's stored ``submission_input`` (format, model and conversation turns), so the agent payload
allowlist and the paid guard can each require exactly that body. A new board format (mind map, table, Kanban, ...)
adds one entry to ``TEXT_FORMATS`` with its prompt, schema and parser; nothing else in the job path changes.
"""
import json
import re

OPERATION = 'board-text'
VERSION = 1
# One original prompt, then (previous result, refinement) pairs: a refine sends the latest result, not the chain.
MAX_TURNS = 3
MAX_TURN_CHARS = 20000
MAX_BODY_BYTES = 128 * 1024
MODEL_CODE = re.compile(r'gemini-[a-z0-9.-]{1,60}')

STICKY_COLORS = ('yellow', 'orange', 'pink', 'purple', 'blue', 'green')
MAX_STICKIES = 24
MAX_STICKY_CHARS = 280

STICKIES_PROMPT = (
    'You turn a request from a Veevee board user into sticky notes for their board. Veevee is a production tool for '
    'filmmakers and artists, so expect brainstorms, shot ideas, story beats, research questions and task lists.\n\n'
    f'Return between 1 and {MAX_STICKIES} sticky notes. Each note holds one idea in at most {MAX_STICKY_CHARS} '
    'characters of plain text: no markdown, no numbering, no surrounding quotes. Use the color to group related '
    f'notes (one of: {", ".join(STICKY_COLORS)}); keep one color when there are no groups. If the request asks for a '
    'number of notes, return that number (up to the limit).\n\n'
    'When the conversation already holds your earlier notes, the latest user message is a refinement: return the '
    'complete revised set of notes, not only the changes.')

STICKIES_SCHEMA = {
    'type': 'OBJECT',
    'properties': {'notes': {'type': 'ARRAY', 'items': {
        'type': 'OBJECT',
        'properties': {'text': {'type': 'STRING'}, 'color': {'type': 'STRING', 'enum': list(STICKY_COLORS)}},
        'required': ['text', 'color']}}},
    'required': ['notes']}


class UnusableResult(ValueError):
    """The model answered, but not with something the board can place."""


def parse_stickies(value):
    notes = value.get('notes') if isinstance(value, dict) else None
    if not isinstance(notes, list):
        raise UnusableResult('The AI answer held no sticky notes.')
    result = []
    for note in notes[:MAX_STICKIES]:
        text = note.get('text') if isinstance(note, dict) else None
        if not isinstance(text, str) or not text.strip():
            continue
        color = note.get('color')
        result.append({'text': text.strip()[:MAX_STICKY_CHARS], 'color': color if color in STICKY_COLORS else STICKY_COLORS[0]})
    if not result:
        raise UnusableResult('The AI answer held no sticky notes.')
    return {'notes': result}


TEXT_FORMATS = {
    'stickies': {'prompt': STICKIES_PROMPT, 'schema': STICKIES_SCHEMA, 'max_output_tokens': 8192, 'temperature': 0.7,
                 'parse': parse_stickies},
}


def generation_config(name):
    spec = TEXT_FORMATS[name]
    return {'responseMimeType': 'application/json', 'responseSchema': spec['schema'],
            'maxOutputTokens': spec['max_output_tokens'], 'temperature': spec['temperature']}


def conversation(prompt, previous=None):
    """The turns a job sends: the prompt alone, or (first prompt, previous result, refinement) for a refine."""
    if previous is None:
        return [{'role': 'user', 'text': prompt}]
    first, output = previous
    return [{'role': 'user', 'text': first}, {'role': 'model', 'text': json.dumps(output, ensure_ascii=False, separators=(',', ':'))},
            {'role': 'user', 'text': prompt}]


def submission_input(name, model, turns):
    """The stored, immutable execution input of a board text job (``Generation.submission_input``)."""
    if name not in TEXT_FORMATS:
        raise ValueError('Unknown board text format.')
    if not isinstance(model, str) or MODEL_CODE.fullmatch(model) is None:
        raise ValueError('The board text model is not a Gemini model code.')
    if not valid_turns(turns):
        raise ValueError('Invalid board conversation.')
    return {'version': VERSION, 'operation': OPERATION, 'format': name, 'model': model,
            'turns': [{'role': turn['role'], 'text': turn['text']} for turn in turns]}


def valid_turns(turns):
    if not isinstance(turns, list) or not 1 <= len(turns) <= MAX_TURNS or len(turns) % 2 != 1:
        return False
    for index, turn in enumerate(turns):
        if (not isinstance(turn, dict) or set(turn) != {'role', 'text'} or turn['role'] != ('user' if index % 2 == 0 else 'model')
                or not isinstance(turn['text'], str) or not turn['text'].strip() or len(turn['text']) > MAX_TURN_CHARS):
            return False
    return True


def is_board_input(value):
    return (isinstance(value, dict) and type(value.get('version')) is int and value['version'] == VERSION
            and value.get('operation') == OPERATION and value.get('format') in TEXT_FORMATS)


def build_body(value):
    """The exact generateContent body for a stored board text input."""
    if not is_board_input(value) or not valid_turns(value.get('turns')):
        raise ValueError('Invalid board text input.')
    name = value['format']
    return {'systemInstruction': {'parts': [{'text': TEXT_FORMATS[name]['prompt']}]},
            'contents': [{'role': turn['role'], 'parts': [{'text': turn['text']}]} for turn in value['turns']],
            'generationConfig': generation_config(name)}


def body_format(body):
    """The text format whose exact request shape ``body`` has, else None."""
    if not isinstance(body, dict) or set(body) != {'systemInstruction', 'contents', 'generationConfig'}:
        return None
    for name, spec in TEXT_FORMATS.items():
        if body['systemInstruction'] == {'parts': [{'text': spec['prompt']}]} and body['generationConfig'] == generation_config(name):
            contents = body['contents']
            if not isinstance(contents, list):
                return None
            turns = []
            for item in contents:
                if not isinstance(item, dict) or set(item) != {'role', 'parts'} or not isinstance(item['parts'], list) or len(item['parts']) != 1:
                    return None
                part = item['parts'][0]
                if not isinstance(part, dict) or set(part) != {'text'}:
                    return None
                turns.append({'role': item['role'], 'text': part['text']})
            if not valid_turns(turns) or len(json.dumps(body, separators=(',', ':'))) > MAX_BODY_BYTES:
                return None
            return name
    return None


def parse_output(name, text):
    """The validated result of a board text job from the model's JSON text."""
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        raise UnusableResult('The AI answer was not valid JSON.') from None
    return TEXT_FORMATS[name]['parse'](value)


def estimated_tokens(value):
    """Input characters / 4 plus the format's whole output budget: a conservative per-call token count."""
    characters = len(TEXT_FORMATS[value['format']]['prompt']) + sum(len(turn['text']) for turn in value['turns'])
    return -(-characters // 4) + TEXT_FORMATS[value['format']]['max_output_tokens']
