"""Live facilitation on a board (area D): the timer, voting sessions and the private mode setting.

Nothing here is realtime. Each state lives in a small row, every client reads one `snapshot` on the board's poll
cadence (a few seconds), and the server's clock decides every deadline: a timer and a voting session carry the
server time they end at, and the snapshot carries the server's "now", so clients count down locally and agree.
"""
import uuid
from django.db import IntegrityError, transaction
from django.db.models import Count, F, Sum
from . import private_mode
from .activity import snippet
from .models import (BoardPrivateMode, BoardTimer, CanvasBoard, VotingDone, VotingSession, VotingVote)

MIN_TIMER_MS = 1000
MAX_TIMER_MS = 8 * 60 * 60 * 1000
TIMER_MUSIC = ('calm', 'focus', 'upbeat', 'tick')
MAX_VOTES_PER_PERSON = 99
MIN_VOTING_MS = 10 * 1000
MAX_VOTING_MS = 24 * 60 * 60 * 1000
MAX_SESSION_NAME = 120
VOTABLE_TYPES = ('sticky', 'text', 'shape', 'rect', 'ellipse', 'triangle', 'diamond', 'image', 'frame', 'stack',
                 'diagram', 'erd', 'swimlane')
TOP_RESULTS = 3


class FacilitationError(Exception):
    def __init__(self, error, status=400):
        super().__init__(error)
        self.error, self.status = error, status


def _integer(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value) or not low <= value <= high:
        raise FacilitationError(f'{name} must be a whole number from {low} to {high}.')
    return int(value)


# --- Timer -----------------------------------------------------------------------------------------------

def timer_state(row, now):
    """The timer as clients read it. A running timer past its end stays `running` with `endsAt` behind `now`;
    the client shows zero and rings once per `run`."""
    if row is None:
        return {'state': 'stopped', 'durationMs': 0, 'endsAt': None, 'remainingMs': None, 'music': None,
                'startedBy': None, 'run': 0}
    return {'state': row.state, 'durationMs': row.duration_ms, 'endsAt': row.ends_at, 'remainingMs': row.remaining_ms,
            'music': row.music, 'startedBy': str(row.started_by) if row.started_by else None, 'run': row.run}


def timer_action(board_id, actor, now, data):
    """start {durationMs, music?}, pause, resume, stop, add {addMs}. Returns the new timer state."""
    action = data.get('action')
    with transaction.atomic():
        row = BoardTimer.objects.select_for_update().filter(board_id=board_id).first()
        if row is None:
            row = BoardTimer(board_id=board_id, state='stopped', duration_ms=0, run=0, updated_at=now)
        running = row.state == 'running' and row.ends_at is not None
        if action == 'start':
            row.duration_ms = _integer(data.get('durationMs'), MIN_TIMER_MS, MAX_TIMER_MS, 'Timer length')
            music = data.get('music')
            if music is not None and music not in TIMER_MUSIC:
                raise FacilitationError('Unknown timer music.')
            row.music = music
            row.state, row.ends_at, row.remaining_ms = 'running', now + row.duration_ms, None
            row.started_by, row.run = actor, row.run + 1
        elif action == 'pause':
            if not running or row.ends_at <= now:
                raise FacilitationError('TIMER_NOT_RUNNING', 409)
            row.state, row.remaining_ms, row.ends_at = 'paused', row.ends_at - now, None
        elif action == 'resume':
            if row.state != 'paused':
                raise FacilitationError('TIMER_NOT_PAUSED', 409)
            row.state, row.ends_at, row.remaining_ms = 'running', now + (row.remaining_ms or 0), None
        elif action == 'stop':
            row.state, row.ends_at, row.remaining_ms = 'stopped', None, None
        elif action == 'add':
            add = _integer(data.get('addMs'), MIN_TIMER_MS, MAX_TIMER_MS, 'Added time')
            if row.state == 'paused':
                row.remaining_ms = min((row.remaining_ms or 0) + add, MAX_TIMER_MS)
            elif running and row.ends_at > now:
                row.ends_at = min(row.ends_at + add, now + MAX_TIMER_MS)
            else:
                raise FacilitationError('TIMER_NOT_RUNNING', 409)
        elif action == 'music':
            music = data.get('music')
            if music is not None and music not in TIMER_MUSIC:
                raise FacilitationError('Unknown timer music.')
            row.music = music
        else:
            raise FacilitationError('Unknown timer action.')
        row.updated_at = now
        row.save()
        return timer_state(row, now)


# --- Voting ----------------------------------------------------------------------------------------------

def _settle_votes(board_id, now):
    """An active session past its end is ended, at the time it was due to end."""
    VotingSession.objects.filter(board_id=board_id, status='active', ends_at__lte=now).update(
        status='ended', ended_at=F('ends_at'))


def _session_dict(row):
    return {'id': str(row.id), 'name': row.name, 'status': row.status, 'votesPerPerson': row.votes_per_person,
            'oneVotePerObject': row.one_vote_per_object, 'objectTypes': row.object_types, 'area': row.area,
            'durationMs': row.duration_ms, 'startedAt': row.started_at, 'endsAt': row.ends_at, 'endedAt': row.ended_at,
            'showOnBoard': row.show_on_board, 'createdBy': str(row.created_by) if row.created_by else None,
            'createdAt': row.created_at}


def _my_votes(session_id, user_id):
    return {node_id: votes for node_id, votes in
            VotingVote.objects.filter(session_id=session_id, user_id=user_id).values_list('node_id', 'votes')}


def _node_label(node, hide, viewer):
    redacted = private_mode.redact_node(node, viewer, hide)
    return None if redacted.get('hiddenText') else snippet(redacted)


def results(session, graph, viewer, now, mode):
    """Every object that got votes, most first, with the first TOP_RESULTS flagged. Totals are SQL aggregates
    over the votes table, so they never depend on how much of anything the client has loaded."""
    rows = list(VotingVote.objects.filter(session_id=session.id).values('node_id').annotate(
        total=Sum('votes'), voters=Count('user_id')).order_by('-total', 'node_id'))
    nodes = {node['id']: node for node in graph.get('nodes', []) if isinstance(node, dict) and 'id' in node}
    hide = private_mode.hiding(mode, now)
    listed = []
    for position, row in enumerate(rows):
        node = nodes.get(row['node_id'])
        listed.append({'nodeId': row['node_id'], 'votes': row['total'], 'voters': row['voters'],
                       'top': position < TOP_RESULTS, 'present': node is not None,
                       'type': node.get('type') if node else None,
                       'label': _node_label(node, hide, viewer) if node else None})
    return {'results': listed, 'totalVotes': sum(row['votes'] for row in listed),
            'participants': VotingVote.objects.filter(session_id=session.id).values('user_id').distinct().count()}


def _progress(session):
    """What the facilitator watches while voting runs: how many people have voted and how many are done."""
    return {'voted': VotingVote.objects.filter(session_id=session.id).values('user_id').distinct().count(),
            'done': VotingDone.objects.filter(session_id=session.id).count()}


def _normalized_area(area):
    if area is None:
        return None
    if isinstance(area, dict) and isinstance(area.get('frameId'), str) and 0 < len(area['frameId']) <= 120:
        return {'frameId': area['frameId']}
    if isinstance(area, dict) and all(isinstance(area.get(key), (int, float)) and not isinstance(area.get(key), bool)
                                      for key in ('x', 'y', 'w', 'h')) and area['w'] > 0 and area['h'] > 0:
        return {key: area[key] for key in ('x', 'y', 'w', 'h')}
    raise FacilitationError('Voting area must be a frame or a rectangle.')


def _name(value):
    name = value.strip() if isinstance(value, str) else ''
    if not name:
        raise FacilitationError('Name required.')
    return name[:MAX_SESSION_NAME]


def create_session(board_id, actor, now, data):
    """Create a voting session and start it, or with `saveForLater` keep it ready to start later."""
    _settle_votes(board_id, now)
    types = data.get('objectTypes')
    if types is not None:
        if not isinstance(types, list) or not types or any(item not in VOTABLE_TYPES for item in types):
            raise FacilitationError('Pick the object types that can be voted on.')
        types = sorted(set(types))
    duration = data.get('durationMs')
    if duration is not None:
        duration = _integer(duration, MIN_VOTING_MS, MAX_VOTING_MS, 'Voting time')
    save_for_later = data.get('saveForLater') is True
    with transaction.atomic():
        CanvasBoard.objects.select_for_update().filter(pk=board_id).first()
        if not save_for_later and VotingSession.objects.filter(board_id=board_id, status='active').exists():
            raise FacilitationError('VOTING_ALREADY_RUNNING', 409)
        session = VotingSession(
            id=uuid.uuid4(), board_id=board_id, name=_name(data.get('name')),
            status='saved' if save_for_later else 'active',
            votes_per_person=_integer(data.get('votesPerPerson'), 1, MAX_VOTES_PER_PERSON, 'Votes per person'),
            one_vote_per_object=data.get('oneVotePerObject') is True, object_types=types,
            area=_normalized_area(data.get('area')), duration_ms=duration, created_by=actor,
            created_at=now, updated_at=now)
        if not save_for_later:
            _start(session, now)
        session.save()
    return session


def _start(session, now):
    session.status, session.started_at = 'active', now
    session.ends_at = now + session.duration_ms if session.duration_ms else None


def session_action(board_id, session_id, actor, now, data):
    """start (a saved session), end, addTime {addMs}, rename {name}, showOnBoard {value}, delete."""
    _settle_votes(board_id, now)
    action = data.get('action')
    with transaction.atomic():
        CanvasBoard.objects.select_for_update().filter(pk=board_id).first()
        session = VotingSession.objects.select_for_update().filter(pk=session_id, board_id=board_id).first()
        if session is None:
            raise FacilitationError('Voting session not found.', 404)
        if action == 'start':
            if session.status != 'saved':
                raise FacilitationError('VOTING_NOT_SAVED', 409)
            if VotingSession.objects.filter(board_id=board_id, status='active').exists():
                raise FacilitationError('VOTING_ALREADY_RUNNING', 409)
            _start(session, now)
        elif action == 'end':
            if session.status != 'active':
                raise FacilitationError('VOTING_NOT_ACTIVE', 409)
            session.status, session.ended_at = 'ended', now
        elif action == 'addTime':
            if session.status != 'active':
                raise FacilitationError('VOTING_NOT_ACTIVE', 409)
            add = _integer(data.get('addMs'), MIN_VOTING_MS, MAX_VOTING_MS, 'Added time')
            session.ends_at = (session.ends_at or now) + add
        elif action == 'rename':
            session.name = _name(data.get('name'))
        elif action == 'showOnBoard':
            if session.status != 'ended':
                raise FacilitationError('Only a finished session can show its results on the board.', 409)
            on = data.get('value') is True
            if on:
                VotingSession.objects.filter(board_id=board_id, show_on_board=True).exclude(pk=session.pk).update(show_on_board=False)
            session.show_on_board = on
        elif action == 'delete':
            if session.status == 'active':
                raise FacilitationError('End the session before deleting it.', 409)
            session.delete()
            return None
        else:
            raise FacilitationError('Unknown voting action.')
        session.updated_at = now
        session.save()
    return session


def _eligible(session, node, graph):
    """Whether `node` can be voted on in `session`: its type and the area the session is limited to."""
    if session.object_types is not None and node.get('type') not in session.object_types:
        return False
    area = session.area
    if not area:
        return True
    if 'frameId' in area:
        return node.get('parentId') == area['frameId'] or node.get('id') == area['frameId']
    x, y = node.get('x', 0) + node.get('w', 0) / 2, node.get('y', 0) + node.get('h', 0) / 2
    return area['x'] <= x <= area['x'] + area['w'] and area['y'] <= y <= area['y'] + area['h']


def cast_vote(board_id, session_id, user_id, now, data):
    """Set this person's votes on one object: `votes` is the new count for it (0 removes it). Everything is
    enforced here: the session is running, the object can be voted on, and the person stays within their votes."""
    _settle_votes(board_id, now)
    node_id = data.get('nodeId')
    if not isinstance(node_id, str) or not 0 < len(node_id) <= 200:
        raise FacilitationError('nodeId required.')
    count = _integer(data.get('votes'), 0, MAX_VOTES_PER_PERSON, 'Votes')
    with transaction.atomic():
        session = VotingSession.objects.select_for_update().filter(pk=session_id, board_id=board_id).first()
        if session is None:
            raise FacilitationError('Voting session not found.', 404)
        if session.status != 'active':
            raise FacilitationError('VOTING_NOT_ACTIVE', 409)
        if VotingDone.objects.filter(session=session, user_id=user_id).exists():
            raise FacilitationError('VOTING_DONE', 409)
        if session.one_vote_per_object and count > 1:
            raise FacilitationError('This session allows one vote per object.', 409)
        mine = _my_votes(session.pk, user_id)
        used_elsewhere = sum(votes for key, votes in mine.items() if key != node_id)
        if used_elsewhere + count > session.votes_per_person:
            raise FacilitationError('NO_VOTES_LEFT', 409)
        if count:
            graph = CanvasBoard.objects.filter(pk=board_id).values_list('data', flat=True).first() or {}
            node = next((item for item in graph.get('nodes', []) if isinstance(item, dict) and item.get('id') == node_id), None)
            if node is None or not _eligible(session, node, graph):
                raise FacilitationError('That object cannot be voted on in this session.', 409)
            VotingVote.objects.update_or_create(session=session, user_id=user_id, node_id=node_id,
                                                defaults={'votes': count, 'updated_at': now})
        else:
            VotingVote.objects.filter(session=session, user_id=user_id, node_id=node_id).delete()
    return _my_votes(session_id, user_id)


def mark_done(board_id, session_id, user_id, now, done):
    _settle_votes(board_id, now)
    session = VotingSession.objects.filter(pk=session_id, board_id=board_id).first()
    if session is None:
        raise FacilitationError('Voting session not found.', 404)
    if session.status != 'active':
        raise FacilitationError('VOTING_NOT_ACTIVE', 409)
    if done:
        try:
            with transaction.atomic():
                VotingDone.objects.create(session=session, user_id=user_id, created_at=now)
        except IntegrityError:
            pass
    else:
        VotingDone.objects.filter(session=session, user_id=user_id).delete()


def list_sessions(board_id, viewer, now, graph):
    """The board's voting history, newest first, finished sessions with their results."""
    _settle_votes(board_id, now)
    mode = private_mode.mode_row(board_id)
    out = []
    for session in VotingSession.objects.filter(board_id=board_id).order_by('-created_at')[:100]:
        entry = _session_dict(session)
        if session.status == 'ended':
            entry.update(results(session, graph, viewer, now, mode))
        out.append(entry)
    return out


def _active_entry(session, viewer, is_facilitator):
    mine = _my_votes(session.pk, viewer)
    entry = {**_session_dict(session), 'myVotes': mine, 'votesUsed': sum(mine.values()),
             'done': VotingDone.objects.filter(session=session, user_id=viewer).exists()}
    if is_facilitator:
        entry['progress'] = _progress(session)
    return entry


def board_totals(session):
    """Per-object vote totals of the session whose results the board shows."""
    return {row['node_id']: row['total'] for row in
            VotingVote.objects.filter(session_id=session.id).values('node_id').annotate(total=Sum('votes'))}


# --- Private mode ----------------------------------------------------------------------------------------

def private_state(mode, now):
    if mode is None or not mode.active:
        return {'active': False}
    return {'active': True, 'anonymous': mode.anonymous, 'allowOthersEnd': mode.allow_others_end,
            'startedBy': str(mode.started_by) if mode.started_by else None, 'startedAt': mode.started_at,
            'revealAt': mode.reveal_at}


def private_action(board_id, actor, level, now, data):
    """start {anonymous, allowOthersEnd}, reveal (everyone's notes, after a countdown), revealMine (this person's
    notes now). Starting and revealing need edit access; revealing someone else's start needs the starter's
    permission (`allowOthersEnd`) unless the person owns the board."""
    from . import access
    action = data.get('action')
    mode = private_mode.settle(board_id, now)
    if action == 'start':
        with transaction.atomic():
            row = BoardPrivateMode.objects.select_for_update().filter(board_id=board_id).first()
            if row is not None and row.active:
                raise FacilitationError('PRIVATE_MODE_ON', 409)
            row = row or BoardPrivateMode(board_id=board_id)
            row.active, row.reveal_at, row.started_at, row.started_by = True, None, now, actor
            row.anonymous = data.get('anonymous') is True
            row.allow_others_end = data.get('allowOthersEnd') is not False
            row.updated_at = now
            row.save()
        return private_state(row, now)
    if mode is None or not mode.active:
        raise FacilitationError('PRIVATE_MODE_OFF', 409)
    if action == 'reveal':
        if str(mode.started_by) != str(actor) and not mode.allow_others_end and level < access.CO_OWNER:
            raise FacilitationError('FORBIDDEN', 403)
        if mode.reveal_at is None:
            BoardPrivateMode.objects.filter(board_id=board_id, reveal_at__isnull=True).update(
                reveal_at=now + private_mode.REVEAL_COUNTDOWN_MS, updated_at=now)
    elif action == 'revealMine':
        private_mode.write_board(board_id, now, lambda graph: private_mode.reveal_mine(graph, actor))
    else:
        raise FacilitationError('Unknown private mode action.')
    return private_state(private_mode.mode_row(board_id), now)


# --- Snapshot --------------------------------------------------------------------------------------------

def snapshot(board_id, viewer, level, now):
    """Everything a board's clients poll: the server's clock, the timer, the running voting session and what
    the board shows of a finished one, and the private mode setting."""
    from . import access
    mode = private_mode.settle(board_id, now)
    _settle_votes(board_id, now)
    facilitator = level >= access.EDIT
    active = VotingSession.objects.filter(board_id=board_id, status='active').first()
    shown = VotingSession.objects.filter(board_id=board_id, status='ended', show_on_board=True).first()
    return {
        'serverNow': now,
        'timer': timer_state(BoardTimer.objects.filter(board_id=board_id).first(), now),
        'voting': {
            'active': _active_entry(active, viewer, facilitator) if active else None,
            'shown': {'id': str(shown.id), 'name': shown.name, 'totals': board_totals(shown)} if shown else None,
            'savedCount': VotingSession.objects.filter(board_id=board_id, status='saved').count(),
        },
        'privateMode': private_state(mode, now),
    }
