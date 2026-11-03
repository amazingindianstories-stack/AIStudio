"""Board AI formats beyond "Create with AI": Sidekick chat turns, Flow steps, Catch up and AI search.

Each entry is a ``apps.agents.board.TEXT_FORMATS`` entry: a fixed system prompt, a fixed response schema and a fixed
generation config, so the agent payload allowlist and the paid guard keep requiring one exact request body. What varies
between calls (a Sidekick's instructions and knowledge, the board summary, a Flow step's task and inputs) travels in the
last user turn, never in the system prompt. Only the two web formats (``sidekick-web``, ``flowstep-web``) carry a tool,
Gemini's ``google_search`` grounding; its fee (``Board AI web search`` in the pricing table) is in the quote, the
monthly AI credits and the Gemini spend window. Every other format sends no tools.
"""
import re

# The named sticky colors (the frontend's STICKY_FILLS holds their fills). A color outside the list travels as a six digit
# hex in "fill", which wins over the name; apps.agents.board shares both.
STICKY_COLORS = ('yellow', 'orange', 'pink', 'purple', 'blue', 'green', 'red', 'teal', 'black', 'white', 'grey')
HEX_COLOR = re.compile(r'#[0-9a-fA-F]{6}')
ACTION_OPS = ('add', 'update', 'delete', 'connect')
ADD_TYPES = ('sticky', 'text', 'rect', 'ellipse', 'diamond', 'frame')
MAX_ACTIONS = 40
MAX_OPTIONS = 5
MAX_PLAN_STEPS = 8
MAX_REPLY_CHARS = 4000
MAX_TEXT_CHARS = 600
MAX_REF_CHARS = 64
MAX_FLOW_OUTPUT_CHARS = 4000
MAX_SUMMARY_CHARS = 2000
MAX_HIGHLIGHTS = 12
MAX_ITEM_CHARS = 300
MAX_TERMS = 6
MAX_TERM_CHARS = 60
MAX_COORDINATE = 1_000_000
# A Sidekick turn carries instructions (8k), knowledge (200k), the board summary (40k) and up to three sources (60k) in
# one user turn (apps.canvas.sidekicks budgets each part under this limit).
SIDEKICK_TURN_CHARS = 320_000
SIDEKICK_BODY_BYTES = 560_000
SIDEKICK_MAX_TURNS = 9
SMALL_TURN_CHARS = 60_000
SMALL_BODY_BYTES = 128 * 1024

SIDEKICK_PROMPT = (
    'You are a Sidekick: an AI teammate working on a Veevee board, a whiteboard for filmmakers and artists. The user '
    'message holds the Sidekick\'s own instructions and knowledge, a compact summary of the board (one line per object: '
    'id, type, position, size and text), optional context from other Veevee sources, and the request.\n\n'
    'Answer in "reply" in plain text, briefly. When the request is too vague to act on, ask one clarifying question '
    f'and give up to {MAX_OPTIONS} short answer choices in "options", and make no changes yet. For work that takes '
    f'several steps, list the steps (at most {MAX_PLAN_STEPS}) in "plan" and do them in "actions".\n\n'
    f'"actions" change the board, at most {MAX_ACTIONS}. Each has an "op": "add" creates an object (type one of '
    f'{", ".join(ADD_TYPES)}; text up to {MAX_TEXT_CHARS} characters; color one of {", ".join(STICKY_COLORS)} for '
    'stickies, or "fill" as a six digit hex such as #6f9bd1 for a color the list does not have; x, y, w, h in the '
    'board\'s coordinates, leaving them out places it in free space; "ref" is a short name you give it so a later '
    'connect can point at it); "update" changes the object whose "id" is given (text, color or fill, x, y, w, h); '
    '"delete" removes the object whose "id" is given; "connect" draws an arrow from "from" to "to", each an id of '
    'an existing object or the "ref" of one you add. Only use ids that appear in the board summary. Never delete or '
    'rewrite objects the user did not ask you to change. Text is plain: no markdown.')

WEB_PROMPT = (
    '\n\nYou may search the web when the request needs current or outside facts. Use it only for that, and name the '
    'source in plain text when you rely on it.')
WEB_TOOLS = [{'google_search': {}}]

SIDEKICK_ACTION_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'op': {'type': 'STRING', 'enum': list(ACTION_OPS)},
        'id': {'type': 'STRING'}, 'ref': {'type': 'STRING'}, 'type': {'type': 'STRING', 'enum': list(ADD_TYPES)},
        'text': {'type': 'STRING'}, 'color': {'type': 'STRING', 'enum': list(STICKY_COLORS)}, 'fill': {'type': 'STRING'},
        'x': {'type': 'NUMBER'}, 'y': {'type': 'NUMBER'}, 'w': {'type': 'NUMBER'}, 'h': {'type': 'NUMBER'},
        'from': {'type': 'STRING'}, 'to': {'type': 'STRING'}},
    'required': ['op']}

SIDEKICK_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'reply': {'type': 'STRING'},
        'options': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
        'plan': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
        'actions': {'type': 'ARRAY', 'items': SIDEKICK_ACTION_SCHEMA}},
    'required': ['reply']}

FLOW_PROMPT = (
    'You run one step of a Flow on a Veevee board. The user message holds the step\'s task and, below it, the inputs '
    'taken from the objects connected to this step. Do the task using only those inputs. '
    f'Return the step\'s output as plain text of at most {MAX_FLOW_OUTPUT_CHARS} characters: no markdown '
    'fence, no preamble, nothing but the output itself.')

FLOW_SCHEMA = {'type': 'OBJECT', 'properties': {'text': {'type': 'STRING'}}, 'required': ['text']}

CATCHUP_PROMPT = (
    'You summarize what changed on a Veevee board while the user was away. The user message lists the changes, newest '
    'last: who did what to which object, with the object\'s text. Write a short "summary" of what happened in plain '
    f'text (at most {MAX_SUMMARY_CHARS} characters), then up to {MAX_HIGHLIGHTS} "highlights" in the order a person '
    'should look at them, each one sentence with the "nodeId" of the object it is about when the list names one, '
    'then any "actionItems" that someone should do. Mention only what the list shows.')

CATCHUP_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'summary': {'type': 'STRING'},
        'highlights': {'type': 'ARRAY', 'items': {'type': 'OBJECT', 'properties': {
            'text': {'type': 'STRING'}, 'nodeId': {'type': 'STRING'}}, 'required': ['text']}},
        'actionItems': {'type': 'ARRAY', 'items': {'type': 'STRING'}}},
    'required': ['summary']}

SEARCH_PROMPT = (
    'You turn a plain-language request to find Veevee boards into filters over board metadata (a board\'s name, who '
    'created it and when it was last updated). You cannot search what is written on a board. The '
    'user message holds today\'s date and the request. Return "terms": up to '
    f'{MAX_TERMS} words or short phrases a board name should contain (none when the request names '
    'no subject); "updatedWithinDays": how many days back the last update may be (0 for any time); "createdByMe": true '
    'only when the request says the boards are the user\'s own; and "explanation": one short sentence saying what '
    'you looked for.')

SEARCH_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'terms': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
        'updatedWithinDays': {'type': 'INTEGER'},
        'createdByMe': {'type': 'BOOLEAN'},
        'explanation': {'type': 'STRING'}},
    'required': ['terms', 'updatedWithinDays', 'createdByMe', 'explanation']}


def _unusable(message):
    from .board import UnusableResult
    return UnusableResult(message)


def _text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ''


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) <= MAX_COORDINATE else None


def color_fields(raw):
    """The colour an object or action asks for: a known color name and/or a six digit hex fill, nothing else."""
    result = {}
    if raw.get('color') in STICKY_COLORS:
        result['color'] = raw['color']
    fill = raw.get('fill')
    if isinstance(fill, str) and HEX_COLOR.fullmatch(fill):
        result['fill'] = fill.lower()
    return result


def _action(raw):
    if not isinstance(raw, dict) or raw.get('op') not in ACTION_OPS:
        return None
    op = raw['op']
    action = {'op': op}
    if op == 'connect':
        start, end = _text(raw.get('from'), MAX_REF_CHARS), _text(raw.get('to'), MAX_REF_CHARS)
        return {**action, 'from': start, 'to': end} if start and end and start != end else None
    if op in ('update', 'delete'):
        identifier = _text(raw.get('id'), MAX_REF_CHARS)
        if not identifier:
            return None
        action['id'] = identifier
        if op == 'delete':
            return action
    else:
        kind = raw.get('type')
        action['type'] = kind if kind in ADD_TYPES else 'sticky'
        ref = _text(raw.get('ref'), MAX_REF_CHARS)
        if ref:
            action['ref'] = ref
    text = _text(raw.get('text'), MAX_TEXT_CHARS)
    if text or (op == 'update' and isinstance(raw.get('text'), str)):
        action['text'] = text
    action.update(color_fields(raw))
    for key in ('x', 'y', 'w', 'h'):
        value = _number(raw.get(key))
        if value is not None and (key in ('x', 'y') or value > 0):
            action[key] = value
    if op == 'update' and len(action) == 2:
        return None
    return action


def _strings(value, limit, length):
    items = [_text(item, length) for item in value] if isinstance(value, list) else []
    return [item for item in items if item][:limit]


def parse_sidekick(value):
    if not isinstance(value, dict):
        raise _unusable('The Sidekick answer was not an object.')
    reply = _text(value.get('reply'), MAX_REPLY_CHARS)
    actions = [action for action in (_action(raw) for raw in (value.get('actions') if isinstance(value.get('actions'), list) else [])[:MAX_ACTIONS]) if action]
    if not reply and not actions:
        raise _unusable('The Sidekick answer held no reply.')
    result = {'reply': reply or 'Done.', 'options': _strings(value.get('options'), MAX_OPTIONS, 120),
              'plan': _strings(value.get('plan'), MAX_PLAN_STEPS, MAX_ITEM_CHARS), 'actions': actions}
    if result['options']:
        # A clarifying question changes nothing yet.
        result['actions'] = []
    return result


def parse_flow_step(value):
    text = _text(value.get('text') if isinstance(value, dict) else None, MAX_FLOW_OUTPUT_CHARS)
    if not text:
        raise _unusable('The Flow step produced no output.')
    return {'text': text}


def parse_catchup(value):
    if not isinstance(value, dict):
        raise _unusable('The summary was not an object.')
    summary = _text(value.get('summary'), MAX_SUMMARY_CHARS)
    if not summary:
        raise _unusable('The summary was empty.')
    highlights = []
    for item in (value.get('highlights') if isinstance(value.get('highlights'), list) else [])[:MAX_HIGHLIGHTS]:
        text = _text(item.get('text') if isinstance(item, dict) else None, MAX_ITEM_CHARS)
        if text:
            node = _text(item.get('nodeId'), MAX_REF_CHARS)
            highlights.append({'text': text, **({'nodeId': node} if node else {})})
    return {'summary': summary, 'highlights': highlights, 'actionItems': _strings(value.get('actionItems'), MAX_HIGHLIGHTS, MAX_ITEM_CHARS)}


def parse_search(value):
    if not isinstance(value, dict):
        raise _unusable('The search answer was not an object.')
    days = value.get('updatedWithinDays')
    days = days if isinstance(days, int) and not isinstance(days, bool) and 0 <= days <= 3650 else 0
    return {'terms': _strings(value.get('terms'), MAX_TERMS, MAX_TERM_CHARS), 'updatedWithinDays': days,
            'createdByMe': value.get('createdByMe') is True, 'explanation': _text(value.get('explanation'), MAX_ITEM_CHARS)}


SIDEKICK_LIMITS = {'max_turns': SIDEKICK_MAX_TURNS, 'max_turn_chars': SIDEKICK_TURN_CHARS, 'max_body_bytes': SIDEKICK_BODY_BYTES}
SMALL_LIMITS = {'max_turns': 3, 'max_turn_chars': SMALL_TURN_CHARS, 'max_body_bytes': SMALL_BODY_BYTES}

FORMATS = {
    'sidekick': {'prompt': SIDEKICK_PROMPT, 'schema': SIDEKICK_SCHEMA, 'max_output_tokens': 8192, 'temperature': 0.6,
                 'parse': parse_sidekick, **SIDEKICK_LIMITS},
    'flowstep': {'prompt': FLOW_PROMPT, 'schema': FLOW_SCHEMA, 'max_output_tokens': 4096, 'temperature': 0.5,
                 'parse': parse_flow_step, **SMALL_LIMITS},
    'catchup': {'prompt': CATCHUP_PROMPT, 'schema': CATCHUP_SCHEMA, 'max_output_tokens': 4096, 'temperature': 0.3,
                'parse': parse_catchup, **SMALL_LIMITS},
    'boardsearch': {'prompt': SEARCH_PROMPT, 'schema': SEARCH_SCHEMA, 'max_output_tokens': 1024, 'temperature': 0.0,
                    'parse': parse_search, **SMALL_LIMITS},
}

# Each web format is its base format with a web-aware system prompt and the grounding tool; ``web`` marks it for the
# quote (apps.generation.services.text_submission) and the paid guard's exact-body check (apps.agents.board.build_body).
for _base in ('sidekick', 'flowstep'):
    FORMATS[f'{_base}-web'] = {**FORMATS[_base], 'prompt': FORMATS[_base]['prompt'] + WEB_PROMPT, 'tools': WEB_TOOLS, 'web': True}

MOCK_OUTPUTS = {
    'sidekick': {'reply': 'Here is a first pass.', 'plan': ['Draft the notes'],
                 'actions': [{'op': 'add', 'type': 'sticky', 'text': 'Mock Sidekick idea', 'color': 'yellow'}]},
    'flowstep': {'text': 'Mock flow output'},
    'catchup': {'summary': 'Mock summary of the changes.', 'highlights': [], 'actionItems': []},
    'boardsearch': {'terms': [], 'updatedWithinDays': 7, 'createdByMe': False, 'explanation': 'Boards updated this week.'},
}
MOCK_OUTPUTS['sidekick-web'] = MOCK_OUTPUTS['sidekick']
MOCK_OUTPUTS['flowstep-web'] = MOCK_OUTPUTS['flowstep']
