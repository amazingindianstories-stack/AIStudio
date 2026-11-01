"""The starter templates and blueprints Veevee ships, written in code (not scraped from anywhere).

Each template is a small board v1 graph: frames for structure, text for headings and stickies for content, so
the blank version (stickies cleared) is a ready scaffold. ``apps.canvas.templates`` serves them next to custom
templates under the ref ``builtin:<slug>``. Kept small on purpose: add one only when it is a real working layout.
"""
from .serialization import validate_state

INK = '#1f2937'
FRAME_STROKE = '#94a3b8'
YELLOW, GREEN, BLUE, PINK, ORANGE, PURPLE = '#fff59d', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#ddd6fe'


class Builder:
    """Collects nodes and connectors with readable ids (`<slug>-<n>`) so a template stays easy to diff."""

    def __init__(self, slug):
        self.slug, self.nodes, self.connectors, self.count = slug, [], [], 0

    def _id(self):
        self.count += 1
        return f'{self.slug}-{self.count}'

    def frame(self, name, x, y, w, h, fill='transparent'):
        node_id = self._id()
        self.nodes.append({'id': node_id, 'type': 'frame', 'x': x, 'y': y, 'w': w, 'h': h, 'parentId': None, 'groupId': None,
                           'name': name, 'fill': fill, 'stroke': FRAME_STROKE})
        return node_id

    def text(self, text, x, y, w=420, h=48, size=28):
        node_id = self._id()
        self.nodes.append({'id': node_id, 'type': 'text', 'x': x, 'y': y, 'w': w, 'h': h, 'parentId': None, 'groupId': None,
                           'text': text, 'fontSize': size, 'align': 'left', 'color': INK})
        return node_id

    def sticky(self, text, x, y, fill=YELLOW, parent=None, size=140):
        node_id = self._id()
        self.nodes.append({'id': node_id, 'type': 'sticky', 'x': x, 'y': y, 'w': size, 'h': size, 'parentId': parent, 'groupId': None,
                           'text': text, 'fill': fill, 'fontSize': 16, 'color': INK})
        return node_id

    def shape(self, kind, text, x, y, w=180, h=90, fill='#ffffff'):
        node_id = self._id()
        self.nodes.append({'id': node_id, 'type': kind, 'x': x, 'y': y, 'w': w, 'h': h, 'parentId': None, 'groupId': None,
                           'fill': fill, 'stroke': INK, 'strokeWidth': 2, 'text': text, 'fontSize': 16, 'color': INK, 'align': 'center'})
        return node_id

    def arrow(self, start, end, label=None):
        connector = {'id': self._id(), 'from': {'nodeId': start, 'anchor': 'auto'}, 'to': {'nodeId': end, 'anchor': 'auto'},
                     'kind': 'arrow', 'stroke': INK, 'strokeWidth': 2, 'shape': 'orthogonal', 'endCap': 'arrow'}
        if label:
            connector['labels'] = [{'id': self._id(), 'text': label, 'position': 0.5, 'orientation': 'horizontal'}]
        self.connectors.append(connector)

    def graph(self):
        graph = validate_state({'version': 1, 'viewport': {'x': 0, 'y': 0, 'zoom': 1}, 'nodes': self.nodes, 'connectors': self.connectors})
        graph.pop('viewport')
        return graph


def columns(slug, title, names, notes, fills, width=360, height=560):
    """A heading and one frame per name, each with its example stickies."""
    b = Builder(slug)
    b.text(title, 0, -90, w=900)
    for index, name in enumerate(names):
        x = index * (width + 40)
        frame = b.frame(name, x, 0, width, height)
        for row, note in enumerate(notes[index]):
            b.sticky(note, x + 28 + (row % 2) * 160, 60 + (row // 2) * 160, fills[index], parent=frame)
    return b.graph()


def retro():
    return columns('retro', 'Retrospective: start, stop, continue', ['Start', 'Stop', 'Continue'],
                   [['Pair on reviews', 'Share demos weekly'], ['Late-day merges', 'Unowned tasks'], ['Short standups', 'Written decisions']],
                   [GREEN, PINK, BLUE])


def now_next_later():
    return columns('nnl', 'Now, next, later', ['Now', 'Next', 'Later'],
                   [['Ship the board picker', 'Fix save conflicts'], ['Share templates'], ['Plan the offsite']],
                   [GREEN, YELLOW, BLUE])


def swot():
    b = Builder('swot')
    b.text('SWOT analysis', 0, -90, w=900)
    cells = [('Strengths', 0, 0, GREEN, 'Fast team'), ('Weaknesses', 560, 0, PINK, 'Thin documentation'),
             ('Opportunities', 0, 400, BLUE, 'New markets'), ('Threats', 560, 400, ORANGE, 'A new competitor')]
    for name, x, y, fill, note in cells:
        frame = b.frame(name, x, y, 520, 360)
        b.sticky(note, x + 28, y + 60, fill, parent=frame)
    return b.graph()


def brainstorm():
    b = Builder('brainstorm')
    b.text('Brainstorm: how might we...', 0, -90, w=900)
    prompt = b.frame('Question', 0, 0, 1160, 200)
    b.sticky('How might we reduce time to first draft?', 28, 28, YELLOW, parent=prompt, size=160)
    ideas = b.frame('Ideas', 0, 240, 760, 480)
    for index, idea in enumerate(['Start from a template', 'Reuse last week\'s board', 'Generate a rough first pass']):
        b.sticky(idea, 28 + index * 160, 60, YELLOW, parent=ideas)
    shortlist = b.frame('Shortlist', 800, 240, 360, 480)
    b.sticky('Start from a template', 28, 60, GREEN, parent=shortlist)
    return b.graph()


def meeting_agenda():
    b = Builder('agenda')
    b.text('Meeting agenda', 0, -90, w=900)
    for index, (name, note) in enumerate([('Check-in', 'Round of one-liners'), ('Topics', 'Add topics as stickies'),
                                         ('Decisions', 'Write what was decided'), ('Actions', 'Owner and date')]):
        x = index * 340
        frame = b.frame(name, x, 0, 300, 520)
        b.sticky(note, x + 28, 60, [BLUE, YELLOW, GREEN, ORANGE][index], parent=frame)
    return b.graph()


def flowchart():
    b = Builder('flow')
    b.text('Flowchart', 0, -90, w=900)
    start = b.shape('ellipse', 'Start', 0, 0, fill=GREEN)
    step = b.shape('rect', 'Do the work', 260, 0, fill=BLUE)
    check = b.shape('diamond', 'Done?', 520, -20, w=180, h=130, fill=YELLOW)
    end = b.shape('ellipse', 'Finish', 800, 0, fill=GREEN)
    b.arrow(start, step)
    b.arrow(step, check)
    b.arrow(check, end, 'Yes')
    b.arrow(check, step, 'No')
    return b.graph()


def moodboard():
    b = Builder('mood')
    b.text('Image mood board', 0, -90, w=900)
    for index, (name, note, fill) in enumerate([('Subject', 'Who or what is in the image', YELLOW), ('Style', 'Medium, era, lens', BLUE),
                                                ('Palette', 'Three colors to hold to', PINK), ('References', 'Drop images here', GREEN)]):
        x = (index % 2) * 560
        y = (index // 2) * 440
        frame = b.frame(name, x, y, 520, 400)
        b.sticky(note, x + 28, y + 60, fill, parent=frame)
    return b.graph()


def prompt_lab():
    b = Builder('prompts')
    b.text('Prompt lab: iterate, compare, keep the best', 0, -90, w=1000)
    for index, name in enumerate(['Prompt v1', 'Prompt v2', 'Prompt v3']):
        x = index * 420
        frame = b.frame(name, x, 0, 380, 640)
        b.sticky('Write the prompt', x + 28, 60, YELLOW, parent=frame)
        b.sticky('What changed and why', x + 190, 60, BLUE, parent=frame)
    return b.graph()


def storyboard():
    b = Builder('story')
    b.text('Storyboard', 0, -90, w=900)
    for index in range(6):
        x, y = (index % 3) * 420, (index // 3) * 420
        frame = b.frame(f'Shot {index + 1}', x, y, 380, 380)
        b.sticky('Describe the shot', x + 28, y + 60, YELLOW if index % 2 == 0 else BLUE, parent=frame)
    return b.graph()


def _entry(slug, name, description, category, tags, build, collections=(), featured=False):
    return {'slug': slug, 'name': name, 'description': description, 'category': category, 'tags': list(tags),
            'collections': list(collections), 'featured': featured, 'graph': build()}


TEMPLATES = [
    _entry('retro-start-stop-continue', 'Retrospective: start, stop, continue',
           'Three columns for a team retrospective, each with example notes.', 'agile', ['retro', 'team'], retro,
           ['popular'], featured=True),
    _entry('now-next-later', 'Now, next, later', 'A light roadmap in three horizons.', 'strategy-planning',
           ['roadmap', 'planning'], now_next_later, ['new']),
    _entry('swot', 'SWOT analysis', 'Strengths, weaknesses, opportunities and threats in a grid.', 'strategy-planning',
           ['strategy'], swot),
    _entry('brainstorm-hmw', 'Brainstorm: how might we', 'A question, a space for ideas and a shortlist.', 'ideation',
           ['brainstorm', 'ideas'], brainstorm, ['popular']),
    _entry('meeting-agenda', 'Meeting agenda', 'Check-in, topics, decisions and actions for a working session.',
           'meetings', ['meeting', 'workshop'], meeting_agenda),
    _entry('flowchart-starter', 'Flowchart', 'A start, a step, a decision and a loop back, already connected.',
           'diagramming', ['flowchart', 'process'], flowchart),
    _entry('image-moodboard', 'Image mood board', 'Subject, style, palette and references before you generate.',
           'image-creation', ['image', 'moodboard', 'ai'], moodboard, ['new', 'ai-accelerated'], featured=True),
    _entry('prompt-lab', 'Prompt lab', 'Three prompt versions side by side with what changed and why.',
           'image-creation', ['prompt', 'image', 'ai'], prompt_lab, ['new', 'ai-accelerated']),
    _entry('storyboard-six-shots', 'Storyboard: six shots', 'Six framed shots for a short video or image series.',
           'image-creation', ['storyboard', 'video', 'ai'], storyboard, ['ai-accelerated']),
]

BLUEPRINTS = [
    {'slug': 'product-launch', 'name': 'Product launch', 'featured': True,
     'description': 'A project with a brainstorm, a roadmap and a retrospective board.',
     'boards': [{'name': 'Brainstorm', 'template': 'brainstorm-hmw'}, {'name': 'Roadmap', 'template': 'now-next-later'},
                {'name': 'Retrospective', 'template': 'retro-start-stop-continue'}]},
    {'slug': 'image-campaign', 'name': 'Image campaign',
     'description': 'A project with a mood board, a prompt lab and a storyboard board.',
     'boards': [{'name': 'Mood board', 'template': 'image-moodboard'}, {'name': 'Prompt lab', 'template': 'prompt-lab'},
                {'name': 'Storyboard', 'template': 'storyboard-six-shots'}]},
]

_BY_SLUG = {item['slug']: item for item in TEMPLATES}
_BLUEPRINTS_BY_SLUG = {item['slug']: item for item in BLUEPRINTS}


def template(slug):
    return _BY_SLUG.get(slug)


def blueprint(slug):
    return _BLUEPRINTS_BY_SLUG.get(slug)
