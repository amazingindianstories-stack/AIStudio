"""Role-bound reference groups. The artist's prompt is never paraphrased."""
import os
from apps.generation.references import asset_slugs, mention_indices
from .shot_spec import ROLE_RULE, parse_ref_roles, role_header, build_reference_legend, build_shot_instruction, has_visible_people, has_explicit_ref_role
from .vision_templates import T

KIND_LABEL = {'character':'CHARACTER','outfit':'OUTFIT','location':'LOCATION','style':'STYLE','prop':'PROP','audio':'AUDIO','other':'REFERENCE'}
ASSET_ROLE = {'character':'person','outfit':'outfit','location':'location','style':'style','prop':'prop','audio':'other','other':'other'}
KIND_RULE = {**{kind:ROLE_RULE[role] for kind,role in ASSET_ROLE.items() if role in ROLE_RULE},
    'audio':'reproduce the audio style, voice tone or acoustic atmosphere represented here',
    'other':'reproduce the visual subject shown in this reference exactly'}


def assemble_prompt(prompt,assets,uploads,opts=None,*,read_image=None,prep_reference=None,
                    analyze_identity=None,detect_role=None,env=None):
    from apps.media.storage import get_storage
    from . import image_prep
    env = os.environ if env is None else env
    opts = opts or {}
    read_image = read_image or (lambda ref:get_storage().read_as_base64(ref))
    prep_reference = prep_reference or image_prep.prep_reference
    analyze_identity = analyze_identity or (lambda mime,data,limit=3:image_prep.analyze_identity_reference(mime,data,limit,env=env))
    detect_role = detect_role or (lambda mime,data:image_prep.detect_reference_role(mime,data,env=env))
    shot = env.get('PROMPT_SHOT_SPEC') == '1'
    detect = env.get('PROMPT_ROLE_DETECT') == '1'
    text_roles = parse_ref_roles(prompt) if shot else {}
    groups,legend_entries = [],[]

    def read_all(refs):
        result = []
        for ref in refs:
            try:
                image = read_image(ref)
                result.append(prep_reference(image['mimeType'],image['data']))
            except Exception:
                raise ValueError('An attached reference image could not be read. Upload it again before generating.') from None
        return result

    def face_crops(images,limit=2):
        tiles = []
        for image in images[:limit]:
            if len(tiles) >= 3:
                break
            tiles.extend(analyze_identity(image['mimeType'],image['data'],3-len(tiles))['crops'])
        return tiles

    def subject(images,prepared_tiles=None):
        if not images:
            return
        tiles = face_crops(images) if prepared_tiles is None else prepared_tiles
        header = T['subjectOne'] if len(images) == 1 else T['subjectMany'].replace('2 reference images',f'{len(images)} reference images',1)
        if shot:
            header = role_header('SUBJECT','person',len(images))
            legend_entries.append({'tag':'SUBJECT','role':'person','isPerson':True})
        group = {'tag':'SUBJECT','header':header,'images':images,'identity':True}
        if tiles:
            group['tiles'] = tiles
        groups.append(group)

    def non_person(tag,role,images):
        legend_entries.append({'tag':tag,'role':role,'isPerson':False})
        groups.append({'tag':tag,'header':role_header(tag,role,len(images)),'images':images,'identity':False})

    by_slug = {asset['slug'].lower():asset for asset in assets}
    for slug in asset_slugs(prompt):
        asset = by_slug.get(slug)
        if not asset or not asset.get('images'):
            continue
        images = read_all(asset['images'])
        if not images:
            continue
        kind,tag = asset['kind'],'@'+asset['slug']
        header = f'{tag} — {KIND_LABEL[kind]} "{asset["name"]}" ({len(images)} reference image{"s" if len(images)>1 else ""}; {KIND_RULE[kind]}):'
        if shot:
            role = ASSET_ROLE[kind]
            header = role_header(tag,role,len(images))
            legend_entries.append({'tag':tag,'role':role,'isPerson':role == 'person'})
        group = {'tag':tag,'header':header,'images':images,'identity':kind == 'character'}
        if kind == 'character':
            group['tiles'] = face_crops(images)
        groups.append(group)

    if uploads:
        tagged = [index for index in mention_indices(prompt) if index <= len(uploads)]
        if len(tagged) > 1:
            for index in tagged:
                images = read_all([uploads[index-1]])
                if not images:
                    continue
                tag = f'@img{index}'
                tiles = face_crops(images,1)
                identity = bool(tiles)
                header = f'{tag} — REFERENCE (reproduce this subject exactly; if a person, the same individual — identical facial features, never a lookalike):'
                if shot:
                    role = 'person' if tiles else text_roles.get(tag)
                    if not role:
                        role = (detect_role(images[0]['mimeType'],images[0]['data']) if detect else None) or ('person' if tiles else 'object')
                    header = role_header(tag,role,len(images))
                    legend_entries.append({'tag':tag,'role':role,'isPerson':role == 'person'})
                    identity = role == 'person'
                group = {'tag':tag,'header':header,'images':images,'identity':identity}
                if identity and tiles:
                    group['tiles'] = tiles
                groups.append(group)
        elif len(tagged) == 1 and shot:
            index = tagged[0]
            tag = f'@img{index}'
            images = read_all([uploads[index-1]])
            if images:
                text_role = text_roles.get(tag)
                tiles = face_crops(images,1)
                explicit = text_role is not None and has_explicit_ref_role(prompt,tag,text_role)
                detected = None
                if text_role != 'person' and not tiles and not explicit:
                    detected = detect_role(images[0]['mimeType'],images[0]['data'])
                role = 'person' if text_role == 'person' or tiles else text_role if explicit else detected or 'person'
                if role == 'person':
                    subject(images,tiles) if len(uploads) == 1 else subject(read_all(uploads))
                else:
                    non_person(tag,role,images)
        else:
            images = read_all(uploads)
            if not shot or not images:
                subject(images)
            elif len(images) == 1:
                tiles = face_crops(images)
                if has_visible_people(prompt) or tiles:
                    subject(images,tiles)
                else:
                    role = detect_role(images[0]['mimeType'],images[0]['data'])
                    non_person('REFERENCE',role,images) if role and role != 'person' else subject(images,tiles)
            else:
                classified = [(image,analyze_identity(image['mimeType'],image['data'])) for image in images]
                people = [(image,result) for image,result in classified if result['personReference'] is True or result['crops']]
                nonpeople = [(image,result) for image,result in classified if result['personReference'] is False]
                unknown = [(image,result) for image,result in classified if not(result['personReference'] is True or result['crops']) and result['personReference'] is not False]
                if not nonpeople:
                    tiles = [tile for _,result in people for tile in result['crops']]
                    subject(images,tiles or None)
                else:
                    subjects = people+unknown
                    if subjects:
                        tiles = [tile for _,result in subjects for tile in result['crops']]
                        subject([image for image,_ in subjects],tiles or None)
                    by_role = {}
                    for image,_ in nonpeople:
                        role = detect_role(image['mimeType'],image['data']) or 'object'
                        by_role.setdefault(role,[]).append(image)
                    for role,items in by_role.items():
                        non_person('REFERENCE-'+role.upper(),role,items)
    result = {'instruction':prompt,'groups':groups}
    judge = next((group['tiles'][0] for group in groups if group['identity'] and group.get('tiles')),None)
    if judge:
        result['judgeFace'] = judge
    if shot:
        result['shotInstruction'] = build_shot_instruction({'rawPrompt':prompt,'legend':build_reference_legend(legend_entries),
            'aspectRatio':opts.get('aspectRatio') or '1:1','medium':opts.get('medium') or 'image',
            'hasPersonReference':any(entry['isPerson'] for entry in legend_entries)})
    return result
