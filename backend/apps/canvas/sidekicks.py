"""Board Sidekicks: AI teammates you chat with on a board, plus the shared job and AI credit plumbing.

Every Sidekick turn, Flow step, Catch up summary and AI search is a board text job: a ``BoardAiJob`` tied to a text
generation that the generation worker runs under its usual admission, spend window and paid guard (the formats live
in ``apps.agents.sidekick``). Because the paid guard pins each format's system prompt, schema and settings, anything
that varies (a Sidekick's instructions and knowledge, a board summary, Flow inputs) travels as the first user turn
of the conversation, followed by a one-line model acknowledgement, the chat history and the request itself.

Nothing here starts a paid job without a request that carries an Idempotency-Key; the panel always shows the quote
first. A user's monthly AI credit cap (``boardAiMonthlyCapCents``, set by an administrator) is checked before every
submission.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone

from django.db import models

from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.services import text_submission
from apps.generation.services.submission import AdmissionRefused
from apps.library.services import idempotency
from .ai_jobs import ORIGIN, PROCESSING, UUID, JobError, job_json, receipt_key
from .models import BoardAiJob, BoardSidekickChat, Sidekick

OWN_FORMATS = ('sidekick', 'sidekick-web', 'flowstep', 'flowstep-web', 'catchup', 'boardsearch')
CREDIT_SETTING = 'boardAiMonthlyCapCents'
CREDIT_DEFAULT_CENTS = 5000

MAX_NAME = 80
MAX_DESCRIPTION = 300
MAX_INSTRUCTIONS = 8000
MAX_STARTERS = 6
MAX_STARTER = 160
MAX_FILES = 20
MAX_FILE_BYTES = 10 * 1024 * 1024
# About 50k tokens of knowledge text in all, at four characters a token.
KNOWLEDGE_CHARS = 200_000
KNOWLEDGE_TYPES = ('.txt', '.md', '.csv')
MAX_MESSAGE = 8000
MAX_SUMMARY_OBJECTS = 400
SUMMARY_CHARS = 40_000
SOURCE_CHARS = 20_000
MAX_SOURCES = 3
HISTORY_PAIRS = 3
MAX_CHATS = 50
ACK = 'Understood.'

PREMADE = [
    {'id': 'ux-researcher', 'name': 'UX Researcher', 'description': 'Finds themes in notes and turns them into insights.',
     'instructions': 'You are a UX researcher. Cluster the notes on the board into themes, name each theme, surface the pain '
                     'points and opportunities behind them, and say which findings you are least sure about.',
     'starters': ['Cluster these notes into themes', 'What are the top pain points?', 'Write research questions for the next round']},
    {'id': 'product-leader', 'name': 'Product Leader', 'description': 'Prioritises ideas and shapes a plan.',
     'instructions': 'You are a product leader. Weigh the ideas on the board by impact and effort, recommend what to do first '
                     'and why, and turn the choice into clear next steps.',
     'starters': ['Prioritise these ideas by impact and effort', 'Draft a one-page plan from this board', 'What are we missing?']},
    {'id': 'workshop-planner', 'name': 'Workshop Planner', 'description': 'Plans a workshop agenda on the board.',
     'instructions': 'You are a workshop facilitator. Plan a timed agenda with an activity, a purpose and a prompt for each '
                     'block, lay it out on the board as frames, and keep it realistic for the time given.',
     'starters': ['Plan a 90-minute ideation workshop', 'Add an icebreaker to the agenda', 'Turn this agenda into frames']},
    {'id': 'software-architect', 'name': 'Software Architect', 'description': 'Reads and improves system diagrams.',
     'instructions': 'You are a software architect. Read the diagram on the board, point out single points of failure, unclear '
                     'ownership and missing pieces, and propose changes as new shapes and arrows.',
     'starters': ['Review this architecture', 'Where are the risks?', 'Add the missing components']},
    {'id': 'storyboard-artist', 'name': 'Storyboard Artist', 'description': 'Breaks a story into shots and beats.',
     'instructions': 'You are a storyboard artist for film and video. Break the story on the board into scenes and shots, '
                     'one sticky per shot with its framing, action and mood, in reading order from left to right.',
     'starters': ['Break this scene into shots', 'Write a shot list for this sequence', 'Where does the pacing drag?']},
    {'id': 'moodboard-critic', 'name': 'Moodboard Critic', 'description': 'Critiques the look and feel of a moodboard.',
     'instructions': 'You are an art director. Look at the notes and captions on the board, name the visual direction they '
                     'add up to, point out what pulls against it, and suggest what to add or cut.',
     'starters': ['What visual direction is this?', 'What feels off?', 'Suggest what to add']},
]

SKILLS = [
    {'name': 'summarize', 'description': 'Summarize the board', 'prompt': 'Summarize what is on this board in a few sentences and put the summary in a sticky note.'},
    {'name': 'cluster', 'description': 'Group related notes', 'prompt': 'Group the sticky notes on this board by theme: add one frame per theme and move each note into its frame.'},
    {'name': 'ideas', 'description': 'Brainstorm more ideas', 'prompt': 'Add six new ideas that build on what is on this board, one sticky note each.'},
    {'name': 'questions', 'description': 'Ask what is missing', 'prompt': 'List the open questions this board leaves unanswered, one sticky note each.'},
    {'name': 'next-steps', 'description': 'Turn the board into next steps', 'prompt': 'Turn this board into a short list of next steps, one sticky note each, in the order to do them.'},
    {'name': 'diagram', 'description': 'Draw a diagram of this', 'prompt': 'Draw a simple diagram of what the notes on this board describe, with shapes and arrows.'},
]


def _error(message, code=None, status=400):
    return JobError(status, message, code)


# ---- AI credits ---------------------------------------------------------------------------------------------------

def month_start(now=None):
    moment = datetime.fromtimestamp((now_ms() if now is None else now) / 1000, timezone.utc)
    return int(datetime(moment.year, moment.month, 1, tzinfo=timezone.utc).timestamp() * 1000)


def credit_cap(user_id):
    """The user's monthly AI credit cap in estimator cents: their own override, else the account setting, else 5000."""
    from apps.admin_dashboard.models import AppSetting, UserLimit
    from apps.admin_dashboard.views import LIMITS, parse
    override = UserLimit.objects.filter(user_id=user_id, key=CREDIT_SETTING).values_list('value', flat=True).first()
    raw = override if override is not None else AppSetting.objects.filter(key=CREDIT_SETTING).values_list('value', flat=True).first()
    return parse(raw, LIMITS[CREDIT_SETTING])


def credits_used(user_id, now=None):
    """Estimator cents the user's board AI jobs (every format) cost this calendar month, failed and cancelled excepted."""
    since = month_start(now)
    rows = BoardAiJob.objects.filter(user_id=user_id, created_at__gte=since)
    total = Generation.objects.filter(pk__in=rows.values('generation_id')).exclude(status__in=('failed', 'cancelled')) \
        .aggregate(total=models.Sum('cost_cents'))['total']
    return int(total or 0)


def credits(actor):
    cap, used = credit_cap(actor.id), credits_used(actor.id)
    return {'capCents': cap, 'usedCents': used, 'remainingCents': max(0, cap - used), 'resetsAt': _next_month(),
            'prices': action_prices()}


def _next_month():
    start = datetime.fromtimestamp(month_start() / 1000, timezone.utc)
    following = datetime(start.year + (start.month == 12), start.month % 12 + 1, 1, tzinfo=timezone.utc)
    return int(following.timestamp() * 1000)


def action_prices():
    """What one typical call of each AI action costs at the configured rates, for the credits panel."""
    from apps.generation.services.pricing import read_pricing
    prices = {}
    for name in ('sidekick', 'flowstep', 'catchup', 'boardsearch'):
        for processing in PROCESSING:
            try:
                value = {'format': name, 'turns': [{'role': 'user', 'text': 'x' * 4000}]}
                prices.setdefault(name, {})[processing] = text_submission.text_cost(value, read_pricing(), processing)
            except Exception:
                prices.setdefault(name, {})[processing] = None
    return prices


def require_credits(actor, cost_cents):
    cap, used = credit_cap(actor.id), credits_used(actor.id)
    if used + cost_cents > cap:
        raise _error('Your monthly AI credits are used up. Ask an administrator for more.', 'AI_CREDITS_EXHAUSTED', 402)


def request_more_credits(actor, message):
    from apps.common.responses import log_activity
    text = message.strip()[:500] if isinstance(message, str) else ''
    log_activity(actor.id, 'ai_credits_request', {'message': text, 'capCents': credit_cap(actor.id), 'usedCents': credits_used(actor.id)})
    return {'ok': True}


# ---- custom Sidekicks ---------------------------------------------------------------------------------------------

def _is_owner(actor, row):
    return str(row.owner_id) == str(actor.id) or getattr(actor, 'role', None) == 'admin'


def sidekick_json(row, actor):
    owner = _is_owner(actor, row)
    hidden = row.hide_instructions and not owner
    result = {'id': str(row.id), 'name': row.name, 'description': row.description, 'starters': row.starters,
              'processing': row.processing, 'webSearch': row.web_search, 'hideInstructions': row.hide_instructions,
              'shared': row.shared, 'mine': owner, 'custom': True,
              'knowledge': [{'name': item['name'], 'chars': len(item['text'])} for item in row.knowledge],
              'updatedAt': row.updated_at}
    if not hidden:
        result['instructions'] = row.instructions
    return result


def premade_json(item):
    return {**{key: item[key] for key in ('id', 'name', 'description', 'instructions', 'starters')}, 'custom': False,
            'processing': 'basic', 'webSearch': False, 'hideInstructions': False, 'shared': True, 'mine': False,
            'knowledge': []}


def catalogue(actor):
    """Premade Sidekicks, the user's own and the teammates' shared ones, and the slash-command skills."""
    rows = Sidekick.objects.filter(models.Q(owner_id=actor.id) | models.Q(shared=True)).order_by('-updated_at')[:200]
    return {'premade': [premade_json(item) for item in PREMADE], 'custom': [sidekick_json(row, actor) for row in rows],
            'skills': SKILLS, 'limits': {'files': MAX_FILES, 'fileBytes': MAX_FILE_BYTES, 'knowledgeChars': KNOWLEDGE_CHARS,
                                          'types': list(KNOWLEDGE_TYPES)}}


def _text(value, limit, label, required=False):
    if value is None and not required:
        return ''
    if not isinstance(value, str) or (required and not value.strip()):
        raise _error(f'{label} is required.' if required else f'Invalid {label}.')
    value = value.strip()
    if len(value) > limit:
        raise _error(f'{label} is too long (at most {limit} characters).')
    return value


def knowledge_files(raw):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_FILES:
        raise _error(f'A Sidekick takes at most {MAX_FILES} knowledge files.')
    files, total = [], 0
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not isinstance(item.get('text'), str):
            raise _error('Invalid knowledge file.')
        name = item['name'].strip()[:120]
        if not name or not name.lower().endswith(KNOWLEDGE_TYPES):
            raise _error('Knowledge files must be .txt, .md or .csv text files.', 'KNOWLEDGE_TYPE')
        if len(item['text'].encode('utf-8')) > MAX_FILE_BYTES:
            raise _error(f'{name} is over 10 MB.', 'KNOWLEDGE_FILE_TOO_LARGE')
        total += len(item['text'])
        files.append({'name': name, 'text': item['text']})
    if total > KNOWLEDGE_CHARS:
        raise _error('Knowledge is limited to about 50,000 tokens in all.', 'KNOWLEDGE_TOO_LARGE')
    return files


def sidekick_values(body, existing=None):
    if not isinstance(body, dict):
        raise _error('Invalid request.')
    starters = body.get('starters', existing.starters if existing else [])
    if not isinstance(starters, list) or len(starters) > MAX_STARTERS or any(not isinstance(item, str) for item in starters):
        raise _error(f'A Sidekick takes at most {MAX_STARTERS} conversation starters.')
    processing = body.get('processing', existing.processing if existing else 'basic')
    if processing not in PROCESSING:
        raise _error('Unknown processing.', 'UNKNOWN_PROCESSING')
    values = {
        'name': _text(body.get('name', existing.name if existing else None), MAX_NAME, 'Name', True),
        'description': _text(body.get('description', existing.description if existing else ''), MAX_DESCRIPTION, 'Description'),
        'instructions': _text(body.get('instructions', existing.instructions if existing else ''), MAX_INSTRUCTIONS, 'Instructions'),
        'starters': [item.strip()[:MAX_STARTER] for item in starters if item.strip()],
        'processing': processing,
        'web_search': bool(body.get('webSearch', existing.web_search if existing else False)),
        'hide_instructions': bool(body.get('hideInstructions', existing.hide_instructions if existing else False)),
        'shared': bool(body.get('shared', existing.shared if existing else False)),
    }
    values['knowledge'] = knowledge_files(body['knowledge']) if 'knowledge' in body else (existing.knowledge if existing else [])
    return values


def save_sidekick(actor, identifier, body):
    now = now_ms()
    if identifier is None:
        values = sidekick_values(body)
        row = Sidekick.objects.create(id=uuid.uuid4(), owner_id=actor.id, created_at=now, updated_at=now, **values)
        return sidekick_json(row, actor)
    row = custom_row(actor, identifier, owned=True)
    values = sidekick_values(body, row)
    Sidekick.objects.filter(pk=row.pk).update(updated_at=now, **values)
    row.refresh_from_db()
    return sidekick_json(row, actor)


def custom_row(actor, identifier, owned=False):
    row = Sidekick.objects.filter(pk=identifier).first() if isinstance(identifier, str) and UUID.fullmatch(identifier) else None
    if row is None or not (row.shared or _is_owner(actor, row)):
        raise _error('Sidekick not found.', status=404)
    if owned and not _is_owner(actor, row):
        raise _error('Only the Sidekick\'s owner can change it.', 'FORBIDDEN', 403)
    return row


def delete_sidekick(actor, identifier):
    row = custom_row(actor, identifier, owned=True)
    BoardSidekickChat.objects.filter(sidekick=str(row.id)).update(sidekick='deleted')
    row.delete()
    return {'ok': True}


def resolve(actor, key):
    """The Sidekick a chat uses: (id, display name, instructions, knowledge, processing, web search)."""
    premade = next((item for item in PREMADE if item['id'] == key), None)
    if premade is not None:
        return {'id': key, 'name': premade['name'], 'instructions': premade['instructions'], 'knowledge': [],
                'processing': 'basic', 'webSearch': False}
    row = custom_row(actor, key)
    return {'id': str(row.id), 'name': row.name, 'instructions': row.instructions, 'knowledge': row.knowledge,
            'processing': row.processing, 'webSearch': row.web_search}


# ---- chats --------------------------------------------------------------------------------------------------------

def chat_json(chat):
    return {'id': str(chat.id), 'boardId': str(chat.board_id), 'sidekick': chat.sidekick, 'title': chat.title,
            'createdAt': chat.created_at, 'updatedAt': chat.updated_at}


def own_chat(actor, board, identifier):
    chat = BoardSidekickChat.objects.filter(pk=identifier, board=board, user_id=actor.id).first() \
        if isinstance(identifier, str) and UUID.fullmatch(identifier) else None
    if chat is None:
        raise _error('Chat not found.', status=404)
    return chat


def create_chat(actor, board, body):
    key = body.get('sidekick') if isinstance(body, dict) else None
    if not isinstance(key, str) or not key:
        raise _error('Choose a Sidekick.')
    sidekick = resolve(actor, key)
    now = now_ms()
    asked = BoardAiJob.objects.filter(chat_id=models.OuterRef('pk'))
    BoardSidekickChat.objects.filter(board=board, user_id=actor.id).exclude(models.Exists(asked)).delete()
    if BoardSidekickChat.objects.filter(board=board, user_id=actor.id).count() >= MAX_CHATS:
        oldest = BoardSidekickChat.objects.filter(board=board, user_id=actor.id).order_by('updated_at').first()
        oldest.delete()
    chat = BoardSidekickChat.objects.create(id=uuid.uuid4(), board=board, user_id=actor.id, sidekick=sidekick['id'],
                                            title=sidekick['name'], created_at=now, updated_at=now)
    return chat_json(chat)


def list_chats(actor, board):
    # A chat opened for a price quote but never sent has no history to show.
    asked = BoardAiJob.objects.filter(chat_id=models.OuterRef('pk'))
    rows = BoardSidekickChat.objects.filter(board=board, user_id=actor.id).filter(models.Exists(asked)).order_by('-updated_at')[:MAX_CHATS]
    return [chat_json(row) for row in rows]


def chat_turns(actor, board, chat):
    """The chat's history, oldest first: each request with its job (and result once finished)."""
    rows = list(BoardAiJob.objects.filter(chat=chat).order_by('created_at', 'id')[:200])
    generations = {row.id: row for row in Generation.objects.filter(pk__in=[row.generation_id for row in rows])}
    return [job_json(row, generations.get(row.generation_id)) for row in rows]


def delete_chat(actor, board, identifier):
    own_chat(actor, board, identifier).delete()
    return {'ok': True}


def rename_chat(actor, board, identifier, body):
    chat = own_chat(actor, board, identifier)
    title = _text(body.get('title') if isinstance(body, dict) else None, 80, 'Title', True)
    BoardSidekickChat.objects.filter(pk=chat.pk).update(title=title, updated_at=now_ms())
    chat.refresh_from_db()
    return chat_json(chat)


# ---- context ------------------------------------------------------------------------------------------------------

def _line(node, selected):
    if node.get('type') in ('frame', 'erd', 'swimlane', 'diagram'):
        text = node.get('name')
    elif node.get('type') == 'image':
        text = node.get('alt')
    else:
        text = node.get('text')
    text = ' '.join(text.split())[:240] if isinstance(text, str) else ''
    mark = '*' if node['id'] in selected else ''
    box = ','.join(str(round(node.get(key, 0))) for key in ('x', 'y', 'w', 'h'))
    return f"{mark}{node['id']}|{node.get('type')}|{box}|{text}"


def board_summary(data, selection=()):
    """One line per object (id|type|x,y,w,h|text), the selected ones starred, capped at SUMMARY_CHARS."""
    nodes = [node for node in (data.get('nodes') if isinstance(data, dict) else None) or [] if isinstance(node, dict) and isinstance(node.get('id'), str)]
    selected = set(selection)
    nodes.sort(key=lambda node: (node['id'] not in selected, node.get('y', 0), node.get('x', 0)))
    lines, size = [], 0
    for node in nodes[:MAX_SUMMARY_OBJECTS]:
        line = _line(node, selected)
        size += len(line) + 1
        if size > SUMMARY_CHARS:
            break
        lines.append(line)
    connectors = [item for item in (data.get('connectors') if isinstance(data, dict) else None) or [] if isinstance(item, dict)]
    for item in connectors[:100]:
        ends = [item.get(end, {}).get('nodeId') if isinstance(item.get(end), dict) else None for end in ('from', 'to')]
        if all(ends):
            lines.append(f'arrow|{ends[0]}->{ends[1]}')
    header = f'{len(nodes)} objects' + (f', showing {len(lines)}' if len(lines) < len(nodes) else '')
    return header + '\n' + '\n'.join(lines)


def selection_ids(body):
    raw = body.get('selection') if isinstance(body, dict) else None
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 500 or any(not isinstance(item, str) or len(item) > 64 for item in raw):
        raise _error('Invalid selection.')
    return raw


def source_context(actor, board, raw):
    """Text from other Veevee places the user chose: boards they can read and this project's library prompts.
    Nothing outside Veevee is read."""
    from . import access
    if raw is None or raw == []:
        return ''
    if not isinstance(raw, list) or len(raw) > MAX_SOURCES:
        raise _error(f'Choose at most {MAX_SOURCES} sources.')
    blocks = []
    for item in raw:
        kind = item.get('kind') if isinstance(item, dict) else None
        if kind == 'board':
            ident = item.get('id')
            row = access.board_row(ident) if isinstance(ident, str) and UUID.fullmatch(ident) else None
            if row is None or access.role_for(actor, row) < access.READ:
                raise _error('Source not found.', status=404)
            from .models import CanvasBoard
            other = CanvasBoard.objects.filter(pk=ident).values('name', 'data').first()
            blocks.append(f"Board \"{other['name']}\":\n{board_summary(other['data'])}"[:SOURCE_CHARS])
        elif kind == 'library':
            rows = Generation.objects.filter(project_id=board.project_id, user_id=actor.id, status='succeeded') \
                .exclude(kind='text').order_by('-created_at').values_list('prompt', flat=True)[:30]
            prompts = '\n'.join(f'- {" ".join(prompt.split())[:300]}' for prompt in rows if prompt)
            blocks.append(f'Recent prompts in this project\'s library:\n{prompts}'[:SOURCE_CHARS])
        else:
            raise _error('Unknown source.')
    return '\n\n'.join(blocks)


def context_turn(sidekick, summary, sources):
    parts = [f"SIDEKICK: {sidekick['name']}", f"INSTRUCTIONS:\n{sidekick['instructions'] or '(none)'}"]
    for item in sidekick['knowledge']:
        parts.append(f"KNOWLEDGE FILE {item['name']}:\n{item['text']}")
    parts.append(f'BOARD:\n{summary}')
    if sources:
        parts.append(f'SOURCES:\n{sources}')
    return '\n\n'.join(parts)


def history_turns(chat):
    jobs = list(BoardAiJob.objects.filter(chat=chat).order_by('-created_at', '-id')[:HISTORY_PAIRS * 2])
    generations = {row.id: row for row in Generation.objects.filter(pk__in=[row.generation_id for row in jobs], status='succeeded')}
    turns = []
    for job in reversed(jobs):
        generation = generations.get(job.generation_id)
        if generation is not None and isinstance(generation.output, dict) and generation.output.get('reply'):
            turns += [{'role': 'user', 'text': job.prompt}, {'role': 'model', 'text': generation.output['reply']}]
    return turns[-HISTORY_PAIRS * 2:]


def turn_request(actor, board, chat_id, body):
    """The validated chat turn: (chat, format, processing, conversation turns, message)."""
    if not isinstance(body, dict):
        raise _error('Invalid request.')
    chat = own_chat(actor, board, chat_id)
    message = _text(body.get('message'), MAX_MESSAGE, 'Message', True)
    sidekick = resolve(actor, chat.sidekick) if chat.sidekick != 'deleted' else None
    if sidekick is None:
        raise _error('This Sidekick was deleted. Start a new chat.', 'SIDEKICK_DELETED', 409)
    processing = body.get('processing', sidekick['processing'])
    if processing not in PROCESSING:
        raise _error('Unknown processing.', 'UNKNOWN_PROCESSING')
    web = bool(body.get('webSearch', sidekick['webSearch']))
    context = context_turn(sidekick, board_summary(board.data, selection_ids(body)), source_context(actor, board, body.get('sources')))
    turns = [{'role': 'user', 'text': context}, {'role': 'model', 'text': ACK}, *history_turns(chat), {'role': 'user', 'text': message}]
    return chat, 'sidekick-web' if web else 'sidekick', processing, turns, message


def quote_turn(actor, board, chat_id, body):
    _, name, processing, turns, _ = turn_request(actor, board, chat_id, body)
    return quote_job(actor, name, turns, processing)


def submit_turn(actor, board, chat_id, body, idempotency_key):
    chat, name, processing, turns, message = turn_request(actor, board, chat_id, body)
    job = submit_job(actor, board, name, turns, processing, message, idempotency_key, chat=chat)
    BoardSidekickChat.objects.filter(pk=chat.pk).update(updated_at=now_ms(), **({'title': message[:60]} if chat.title == resolve_name(chat) else {}))
    return job


def resolve_name(chat):
    premade = next((item for item in PREMADE if item['id'] == chat.sidekick), None)
    if premade:
        return premade['name']
    row = Sidekick.objects.filter(pk=chat.sidekick).first() if UUID.fullmatch(chat.sidekick) else None
    return row.name if row else ''


# ---- shared quote and submit --------------------------------------------------------------------------------------

def quote_job(actor, name, turns, processing):
    result = text_submission.quote_text(actor, name, turns, processing)
    cap, used = credit_cap(actor.id), credits_used(actor.id)
    return {'format': name, 'processing': processing, 'model': result['model'], 'costCents': result['costCents'],
            'credits': {'capCents': cap, 'usedCents': used, 'remainingCents': max(0, cap - used)}}


def submit_job(actor, board, name, turns, processing, prompt, idempotency_key, *, chat=None, operation='BOARD_SIDEKICK_JOB'):
    """Queue one text job and its job row once per Idempotency-Key; returns the job."""
    key = receipt_key(idempotency_key, actor)
    digest = hashlib.sha256(json.dumps(turns, sort_keys=True).encode('utf-8')).hexdigest()
    fingerprint = {'boardId': str(board.id), 'format': name, 'processing': processing, 'turns': digest,
                   'chat': str(chat.id) if chat else None}

    def mutation():
        created = {}

        def admit(item):
            require_credits(actor, item['costCents'])
            now = now_ms()
            created['job'] = BoardAiJob.objects.create(id=uuid.uuid4(), board=board, user_id=actor.id, format=name, prompt=prompt[:MAX_MESSAGE],
                                                       generation_id=item['id'], chat=chat, created_at=now, updated_at=now)

        text_submission.submit_text(actor, name, turns, processing=processing, origin=ORIGIN, admit=admit)
        return {'jobId': str(created['job'].id)}

    try:
        receipt = idempotency.execute(operation, fingerprint, mutation, actor_id=actor.id, idempotency_key=key)
    except idempotency.OrganizationError as error:
        raise JobError(error.status, str(error), error.code) from None
    except AdmissionRefused as error:
        raise (error.error if isinstance(error.error, JobError) else error) from None
    return job_json(BoardAiJob.objects.get(pk=receipt['jobId']))


def get_job(actor, board, identifier):
    if not isinstance(identifier, str) or not UUID.fullmatch(identifier):
        raise _error('Job not found.', status=404)
    job = BoardAiJob.objects.filter(pk=identifier, board=board, user_id=actor.id).first()
    if job is None:
        raise _error('Job not found.', status=404)
    return job_json(job)

