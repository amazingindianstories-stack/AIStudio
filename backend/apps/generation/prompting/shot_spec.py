"""Literal Node template parity; templates.py is inert source-derived text."""
import re

from .templates import T
ROLE_RULE = T['ROLE_RULE']
VIDEO_NEGATIVE_CODA = T['VIDEO_NEGATIVE_CODA']
FLAGS = re.I | re.ASCII


def role_rule(role):
    return ROLE_RULE.get(role)


def role_header(tag,role,image_count):
    return f'{tag} — {T["ROLE_LABEL"].get(role,"undefined")} reference ({image_count} {"image" if image_count == 1 else "images"}): {role_rule(role) or "undefined"}.'


def parse_ref_roles(prompt):
    result = {}
    tokens = prompt.split()
    for index,token in enumerate(tokens):
        match = re.search(r'@([a-z][a-z0-9_-]*)',token,FLAGS)
        if not match:
            continue
        tag = '@'+match[1].lower()
        if tag in result:
            continue
        window = ' '.join(tokens[max(0,index-6):index+7])
        for entry in T['ROLE_KEYWORDS']:
            if re.search(entry['pattern'],window,FLAGS):
                result[tag] = entry['role']
                break
    return result


def infer_non_person_role(prompt):
    return next((entry['role'] for entry in T['ROLE_KEYWORDS'] if entry['role'] != 'person'
        and re.search(entry['pattern'],prompt,FLAGS)),'object')


def has_explicit_ref_role(prompt,tag,role):
    terms = T['EXPLICIT_ROLE_TERMS'][role]
    escaped = re.escape(tag)
    return bool(re.search(escaped+r'(?:\([^)]*\))?\s+(?:as|for|is|defines?|shows?)\s+(?:the\s+)?(?:exact\s+)?(?:'+terms+r')\b',prompt,FLAGS)
        or re.search(r'\b(?:'+terms+r')\b\s+(?:reference\s+)?(?:from|using|of|at|in)\s+'+escaped+r'(?:\([^)]*\))?',prompt,FLAGS))


def build_reference_legend(entries):
    if not entries:
        return None
    lines = []
    labels = {'outfit':'the exact outfit worn by the subject.', 'location':'the exact location/setting of the scene.',
        'style':'the exact visual style/grade to match.', 'prop':'the exact prop/object to reproduce.',
        'object':'the exact object/element to reproduce.'}
    for entry in entries:
        text = 'the exact face/identity of the subject — must be reproduced with exact fidelity to the reference and in its medium, never a lookalike.' if entry.get('isPerson') else labels.get(entry['role'],'a reference to reproduce exactly.')
        lines.append(f'{entry["tag"]} = {text}')
    return 'REFERENCES:\n'+'\n'.join(lines)


def has_visible_people(raw_prompt,has_person_reference=False):
    if has_person_reference:
        return True
    text = raw_prompt
    for key in ('NEGATED_HUMANS_RE','HUMAN_LABELLED_OBJECT_RE'):
        text = re.sub(T['patterns'][key],' ',text,flags=FLAGS)
    return any(re.search(T['patterns'][key],text,re.ASCII if key == 'NAMED_LOOK_RE' else FLAGS)
        for key in ('POSITIVE_HUMAN_NOUN_RE','HUMAN_PRONOUN_RE','HUMAN_ACTION_RE','NAMED_LOOK_RE'))


def build_cast_policy(raw_prompt,has_person_reference=False):
    if has_visible_people(raw_prompt,has_person_reference):
        return None
    suffix = '\n'+T['VIEWPOINT_POLICY'] if re.search(T['patterns']['VIEWPOINT_DIRECTION_RE'],raw_prompt,FLAGS) else ''
    return T['ZERO_CAST_POLICY']+suffix


def build_framing_coda(aspect_ratio,medium='image',subject_mode='person'):
    if aspect_ratio not in ('16:9','21:9'):
        return None
    return T['framing']['video' if medium == 'video' else 'image_'+subject_mode]


def build_shot_instruction(args):
    raw = args['rawPrompt']
    medium = args.get('medium') or 'image'
    mode = 'environment' if medium == 'image' and not has_visible_people(raw,args.get('hasPersonReference',False)) else 'person'
    blocks = [args['legend']] if args.get('legend') else []
    blocks.append('SCENE: '+raw)
    framing = build_framing_coda(args.get('aspectRatio'),medium,mode)
    tail = [framing] if framing else []
    negative = T['VIDEO_NEGATIVE_CODA'] if medium == 'video' else T['ENVIRONMENT_NEGATIVE_CODA'] if mode == 'environment' else T['NEGATIVE_CODA']
    tail.append('AVOID: '+negative)
    blocks.append('\n'.join(tail))
    return '\n\n'.join(blocks)
