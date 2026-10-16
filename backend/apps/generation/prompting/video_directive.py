import re
from .shot_spec import T, FLAGS, build_reference_legend

STYLE_RE = r"\b(anime|manga|cartoon|comic|graphic novel|cel[- ]shaded|toon|3d render|cgi|claymation|stop[- ]motion|puppet|pixel art|voxel|low[- ]poly|watercolou?r|oil painting|gouache|pastel|charcoal|pencil sketch|line art|ink(?:ed)? drawing|illustrat(?:ed|ion)|painterly|storyboard|blueprint|wireframe|noir|silhouette|claymore|ukiyo[- ]e|impressionist|surrealist|photoreal(?:istic)?|live[- ]action|documentary style|found footage|vhs|super ?8|16mm|35mm film|film grain|stylized|stylised)\b"


def has_camera_direction(prompt):
    return bool(re.search(T['patterns']['CAMERA_RE'],prompt,FLAGS))


def has_explicit_style(prompt):
    return bool(re.search(STYLE_RE,prompt,FLAGS))


def _phrase(entries):
    return ', '.join(e['tag'] for e in entries),len(entries) == 1


def _style_lock(count,explicit,entries):
    if explicit:
        return T['genericStyle']['one_explicit' if count == 1 else 'many_explicit']
    styles = [entry for entry in entries if entry['role'] == 'style']
    if styles and len({entry['role'] for entry in entries}) > 1:
        tags,single = _phrase(styles)
        return (f'STYLE — FOLLOW {"THIS TAGGED REFERENCE" if single else "THESE TAGGED REFERENCES"} ONLY (unless the PROMPT '
            f'names a different style, in which case the PROMPT wins): {tags} '
            f'{"defines" if single else "define"} the visual style of this shot, not just its content. '
            f'Reproduce {"its" if single else "their"} medium and rendering '
            'exactly — whether photographic, anime, cel-shaded, 3D-rendered, '
            'illustrated, painterly, stop-motion or any other treatment — '
            'including line quality, shading model, colour palette, level of '
            'detail and degree of stylization. Do NOT take style cues from any '
            'other tagged reference — the other references define identity, '
            'outfit, location or subject matter only, never style. Do NOT convert '
            f'{tags} to photorealism, and do not add realistic skin, lighting or '
            f'texture detail {"it does" if single else "they do"} not have.')
    return T['genericStyle']['one' if count == 1 else 'many']


def _identity_lock(count,syntax,photoreal,entries):
    people = [entry for entry in entries if entry['isPerson']]
    if people and len({entry['role'] for entry in entries}) > 1:
        tags,single = _phrase(people)
        others = [entry for entry in entries if not entry['isPerson']]
        text = (f'IDENTITY LOCK: {"this tagged reference" if single else "these tagged references"} — {tags} — '
            f'{"defines" if single else "define"} the exact, fixed appearance of the people {"it shows" if single else "they show"}. ')
        if others:
            listing = ', '.join(f'{entry["tag"]} = {entry["role"]}' for entry in others)
            text += (f'The other tagged reference{"s" if len(others)>1 else ""} ({listing}) '
                f'contribute{"" if len(others)>1 else "s"} only their own content — not an additional face or person. ')
        text += (f'In EVERY frame, each person referenced by {tags} keeps the same face '
            f'and features as depicted in {"its" if single else "their"} reference — the same facial '
            'structure and proportions, eye shape and colour, brows, nose, mouth, '
            'hair colour and hairstyle, facial hair, body build, apparent age, and '
            'the same distinguishing marks the reference shows — unmistakably the '
            "SAME character, never a lookalike. Keep that subject's wardrobe and "
            'jewelry as referenced unless the prompt explicitly changes them, with '
            'zero identity or wardrobe drift between frames. Never blend or swap '
            'features between different references, and never duplicate a '
            'referenced subject. Anyone else on screen is a DIFFERENT individual '
            'who must not resemble a referenced subject.')
    else:
        text = T['genericIdentity']['one' if count == 1 else 'many_angle' if syntax == 'angle' else 'many_bracket']
    return text+(T['photorealSuffix'] if photoreal else '')


def build_video_directive(input):
    prompt = input['prompt'].strip()
    count = input.get('refCount',0)
    if count <= 0:
        return prompt
    syntax = input.get('tagSyntax','bracket')
    roles = input.get('refRoles') or {}
    entries = [{'tag':f'<<<image_{index}>>>' if syntax == 'angle' else f'[image {index}]',
        'role':role,'isPerson':role == 'person'} for index,role in sorted(roles.items(),key=lambda pair:int(pair[0]))]
    legend = build_reference_legend(entries) if len({entry['role'] for entry in entries}) > 1 else None
    photoreal = bool(re.search(r'\b(photoreal(?:istic)?|live[- ]action|documentary style|found footage|35mm film|16mm|super ?8|vhs|film grain)\b',prompt,FLAGS))
    blocks = [T['DOMAIN_LOCK']]+([legend] if legend else [])
    blocks.extend([_style_lock(count,has_explicit_style(prompt),entries),_identity_lock(count,syntax,photoreal,entries),
        T['USER_FRAMING'] if has_camera_direction(prompt) else T['DEFAULT_FRAMING'],T['TEMPORAL_STAGING'],
        'AVOID: '+T['VIDEO_NEGATIVE_CODA'],T['LITERAL'],'PROMPT:\n'+prompt,T['PRECEDENCE']])
    return '\n\n'.join(blocks)
