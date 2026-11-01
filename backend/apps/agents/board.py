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


MAX_CONTEXT_CHARS = 12000
MAX_REWRITE_ITEMS = 60
MAX_ITEM_CHARS = 2000
MAX_GROUPS = 12
MAX_FRAMES = 8
MAX_DIAGRAM_NODES = 40
MAX_DIAGRAM_EDGES = 80
SHAPE_NAMES = ('rect', 'ellipse', 'diamond', 'triangle')
DIAGRAM_KINDS = ('flowchart', 'mindmap')
SENTIMENTS = ('positive', 'neutral', 'negative')

REWRITE_PROMPT = (
    'You edit the text of objects on a Veevee board. The user message holds an instruction (for example fix grammar, '
    'shorten, change tone, or translate into a language) and a JSON list of items, each with an id and its current text.\n\n'
    'Return every item once with the same id and its revised text. Keep the meaning and the line breaks, and return '
    'plain text only: no markdown, no surrounding quotes. If an item needs no change, return it unchanged. Never add '
    'or drop items.')

REWRITE_SCHEMA = {
    'type': 'OBJECT',
    'properties': {'items': {'type': 'ARRAY', 'items': {
        'type': 'OBJECT', 'properties': {'id': {'type': 'STRING'}, 'text': {'type': 'STRING'}}, 'required': ['id', 'text']}}},
    'required': ['items']}

CLUSTER_PROMPT = (
    'You group sticky notes from a Veevee board. The user message holds a request and a JSON list of notes, each with an '
    'id and its text. Group the notes by the keywords or themes they share, or by sentiment when the request asks for '
    f'it. Return between 1 and {MAX_GROUPS} groups, each with a short title (at most 40 characters) and the ids of the '
    'notes in it. Every note id appears in exactly one group. For a sentiment request, use exactly the titles '
    f'{", ".join(SENTIMENTS)} (leave out a group that would be empty).')

CLUSTER_SCHEMA = {
    'type': 'OBJECT',
    'properties': {'groups': {'type': 'ARRAY', 'items': {
        'type': 'OBJECT',
        'properties': {'title': {'type': 'STRING'}, 'ids': {'type': 'ARRAY', 'items': {'type': 'STRING'}}},
        'required': ['title', 'ids']}}},
    'required': ['groups']}

SUMMARY_PROMPT = (
    'You write a document from content on a Veevee board. The user message holds a request and the selected board '
    'content. Write what the request asks for (a summary, meeting notes, a brief, a proposal) using only that content '
    'and the request. Return a short title (at most 80 characters) and a body in plain text: short paragraphs or lines '
    'starting with "- " for lists, no markdown headings or emphasis. Keep the body under 3000 characters.')

SUMMARY_SCHEMA = {
    'type': 'OBJECT',
    'properties': {'title': {'type': 'STRING'}, 'body': {'type': 'STRING'}},
    'required': ['title', 'body']}

LAYOUT_PROMPT = (
    'You lay out a starting board for a Veevee user, who makes films, ads and visual work: for example a workshop '
    'plan, a story map, a shot list or a meeting recap. Return a board title and between 1 and '
    f'{MAX_FRAMES} frames. Each frame has a short title (at most 40 characters) and up to 8 sticky notes with one idea '
    f'each (at most {MAX_STICKY_CHARS} characters, plain text, no markdown). Order frames as they should read, left to '
    f'right. Use a sticky color (one of: {", ".join(STICKY_COLORS)}) to group related notes. Use the selected board '
    'content as context when the user message holds it.')

LAYOUT_SCHEMA = {
    'type': 'OBJECT',
    'properties': {'title': {'type': 'STRING'}, 'frames': {'type': 'ARRAY', 'items': {
        'type': 'OBJECT',
        'properties': {'title': {'type': 'STRING'}, 'notes': {'type': 'ARRAY', 'items': {
            'type': 'OBJECT',
            'properties': {'text': {'type': 'STRING'}, 'color': {'type': 'STRING', 'enum': list(STICKY_COLORS)}},
            'required': ['text', 'color']}}},
        'required': ['title', 'notes']}}},
    'required': ['title', 'frames']}

DIAGRAM_PROMPT = (
    'You draw diagrams for a Veevee board. Return a diagram as nodes and edges. kind is "flowchart" for a process, '
    f'sequence, architecture or ERD style diagram, or "mindmap" for a mind map (the first node is the centre and every '
    f'edge goes from a parent to a child). Use at most {MAX_DIAGRAM_NODES} nodes. Each node has a unique short id '
    f'(letters and digits), a label of at most 60 characters, a shape (one of: {", ".join(SHAPE_NAMES)}; use diamond for '
    'a decision, ellipse for a start or end) and an optional color as a six digit hex such as #6f9bd1 when the request '
    'names a color, else an empty string. Each edge goes from one node id to another and has an optional label of at '
    'most 30 characters. When the conversation holds your earlier diagram, return the complete revised diagram.')

DIAGRAM_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'kind': {'type': 'STRING', 'enum': list(DIAGRAM_KINDS)},
        'nodes': {'type': 'ARRAY', 'items': {
            'type': 'OBJECT',
            'properties': {'id': {'type': 'STRING'}, 'label': {'type': 'STRING'},
                           'shape': {'type': 'STRING', 'enum': list(SHAPE_NAMES)}, 'color': {'type': 'STRING'}},
            'required': ['id', 'label', 'shape', 'color']}},
        'edges': {'type': 'ARRAY', 'items': {
            'type': 'OBJECT',
            'properties': {'from': {'type': 'STRING'}, 'to': {'type': 'STRING'}, 'label': {'type': 'STRING'}},
            'required': ['from', 'to', 'label']}}},
    'required': ['kind', 'nodes', 'edges']}

HEX_COLOR = re.compile(r'#[0-9a-fA-F]{6}')
NODE_ID = re.compile(r'[A-Za-z0-9_-]{1,32}')


def clean_text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ''


def parse_rewrite(value):
    items = value.get('items') if isinstance(value, dict) else None
    if not isinstance(items, list):
        raise UnusableResult('The AI answer held no edited text.')
    result, seen = [], set()
    for item in items[:MAX_REWRITE_ITEMS]:
        identifier = item.get('id') if isinstance(item, dict) else None
        text = item.get('text') if isinstance(item, dict) else None
        if not isinstance(identifier, str) or identifier in seen or not isinstance(text, str):
            continue
        seen.add(identifier)
        result.append({'id': identifier, 'text': text.strip()[:MAX_ITEM_CHARS]})
    if not result:
        raise UnusableResult('The AI answer held no edited text.')
    return {'items': result}


def parse_cluster(value):
    groups = value.get('groups') if isinstance(value, dict) else None
    if not isinstance(groups, list):
        raise UnusableResult('The AI answer held no groups.')
    result, seen = [], set()
    for group in groups[:MAX_GROUPS]:
        title = clean_text(group.get('title') if isinstance(group, dict) else None, 40)
        ids = group.get('ids') if isinstance(group, dict) else None
        if not title or not isinstance(ids, list):
            continue
        # A note belongs to the first group that names it.
        members = [identifier for identifier in ids if isinstance(identifier, str) and identifier not in seen]
        seen.update(members)
        if members:
            result.append({'title': title, 'ids': members})
    if not result:
        raise UnusableResult('The AI answer held no groups.')
    return {'groups': result}


def parse_summary(value):
    title = clean_text(value.get('title') if isinstance(value, dict) else None, 80)
    body = clean_text(value.get('body') if isinstance(value, dict) else None, 3000)
    if not body:
        raise UnusableResult('The AI answer held no document text.')
    return {'title': title or 'Summary', 'body': body}


def sticky_list(notes):
    result = []
    for note in notes[:8] if isinstance(notes, list) else []:
        text = note.get('text') if isinstance(note, dict) else None
        if isinstance(text, str) and text.strip():
            color = note.get('color')
            result.append({'text': text.strip()[:MAX_STICKY_CHARS], 'color': color if color in STICKY_COLORS else STICKY_COLORS[0]})
    return result


def parse_layout(value):
    frames = value.get('frames') if isinstance(value, dict) else None
    if not isinstance(frames, list):
        raise UnusableResult('The AI answer held no frames.')
    result = []
    for frame in frames[:MAX_FRAMES]:
        if not isinstance(frame, dict):
            continue
        title, notes = clean_text(frame.get('title'), 40), sticky_list(frame.get('notes'))
        if title or notes:
            result.append({'title': title or 'Frame', 'notes': notes})
    if not result:
        raise UnusableResult('The AI answer held no frames.')
    return {'title': clean_text(value.get('title'), 80), 'frames': result}


def parse_diagram(value):
    if not isinstance(value, dict) or not isinstance(value.get('nodes'), list) or not isinstance(value.get('edges'), list):
        raise UnusableResult('The AI answer held no diagram.')
    nodes, ids = [], set()
    for node in value['nodes'][:MAX_DIAGRAM_NODES]:
        if not isinstance(node, dict):
            continue
        identifier, label = node.get('id'), clean_text(node.get('label'), 60)
        if not isinstance(identifier, str) or NODE_ID.fullmatch(identifier) is None or identifier in ids or not label:
            continue
        ids.add(identifier)
        color = node.get('color')
        nodes.append({'id': identifier, 'label': label, 'shape': node.get('shape') if node.get('shape') in SHAPE_NAMES else 'rect',
                      'color': color if isinstance(color, str) and HEX_COLOR.fullmatch(color) else ''})
    edges = []
    for edge in value['edges'][:MAX_DIAGRAM_EDGES]:
        if isinstance(edge, dict) and edge.get('from') in ids and edge.get('to') in ids and edge['from'] != edge['to']:
            edges.append({'from': edge['from'], 'to': edge['to'], 'label': clean_text(edge.get('label'), 30)})
    if not nodes:
        raise UnusableResult('The AI answer held no diagram.')
    return {'kind': value.get('kind') if value.get('kind') in DIAGRAM_KINDS else 'flowchart', 'nodes': nodes, 'edges': edges}


def context_text(items):
    """The selection a client sends as context, as the JSON the prompt expects: [{id, type, text}] bounded to the budget."""
    if not isinstance(items, list):
        raise ValueError('Invalid board context.')
    clean = []
    for item in items[:MAX_REWRITE_ITEMS]:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not isinstance(item.get('text'), str):
            raise ValueError('Invalid board context.')
        entry = {'id': item['id'][:64], 'text': item['text'][:MAX_ITEM_CHARS]}
        if isinstance(item.get('type'), str):
            entry['type'] = item['type'][:20]
        clean.append(entry)
    text = json.dumps(clean, ensure_ascii=False, separators=(',', ':'))
    if len(text) > MAX_CONTEXT_CHARS:
        raise ValueError('The selection is too large to send. Select fewer objects.')
    return text


def first_turn(prompt, context=None):
    """The user's prompt, followed by the selected board content when there is some."""
    return prompt if not context else f'{prompt}\n\nSelected board content (JSON):\n{context}'


TEXT_FORMATS = {
    'stickies': {'prompt': STICKIES_PROMPT, 'schema': STICKIES_SCHEMA, 'max_output_tokens': 8192, 'temperature': 0.7,
                 'parse': parse_stickies},
    'rewrite': {'prompt': REWRITE_PROMPT, 'schema': REWRITE_SCHEMA, 'max_output_tokens': 16384, 'temperature': 0.3, 'parse': parse_rewrite},
    'cluster': {'prompt': CLUSTER_PROMPT, 'schema': CLUSTER_SCHEMA, 'max_output_tokens': 4096, 'temperature': 0.2, 'parse': parse_cluster},
    'summary': {'prompt': SUMMARY_PROMPT, 'schema': SUMMARY_SCHEMA, 'max_output_tokens': 4096, 'temperature': 0.4, 'parse': parse_summary},
    'layout': {'prompt': LAYOUT_PROMPT, 'schema': LAYOUT_SCHEMA, 'max_output_tokens': 8192, 'temperature': 0.7, 'parse': parse_layout},
    'diagram': {'prompt': DIAGRAM_PROMPT, 'schema': DIAGRAM_SCHEMA, 'max_output_tokens': 8192, 'temperature': 0.4, 'parse': parse_diagram},
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
