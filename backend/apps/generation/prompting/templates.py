"""Inert template strings copied verbatim from the Node comparison source."""
T = {'ROLE_RULE': {'person': 'reproduce this exact person with exact fidelity to the reference, in the SAME '
                         'medium and rendering style as the reference (photographic, illustrated, anime, '
                         'cel-shaded, 3D, painterly or otherwise — never convert it to a different medium, '
                         'and never add realism the reference does not have) — identical face shape and bone '
                         'structure, jawline, cheekbones, hairline, eye shape/size/spacing and color, '
                         'eyebrows, nose, lips, ears, facial hair, hairstyle, body build and apparent age, '
                         'plus the same distinguishing marks the reference shows; where the reference is '
                         'photographic, also keep real skin tone and texture (moles, scars, freckles, '
                         'wrinkles); unmistakably the SAME individual, never a lookalike, and never '
                         'beautified, slimmed, de-aged or idealized relative to the reference',
               'outfit': 'reproduce this exact outfit — same garments, cut, fit, fabric, colors, patterns, '
                         'trims and details, plus any jewelry/accessories shown with it',
               'location': 'reproduce this exact place — same architecture, layout, materials, signage, '
                           'furnishing and mood',
               'style': 'match this exact visual style — same rendering, palette, grain and lighting '
                        'treatment',
               'prop': 'reproduce this exact object — same shape, colors, materials, markings and wear',
               'object': 'reproduce this exact object/element as shown — same shape, colors, materials and '
                         'details, used exactly as the SCENE directs'},
 'ROLE_LABEL': {'person': 'FACE/IDENTITY',
                'outfit': 'OUTFIT',
                'location': 'LOCATION',
                'style': 'STYLE',
                'prop': 'PROP',
                'object': 'OBJECT'},
 'ROLE_KEYWORDS': [{'role': 'outfit',
                    'pattern': '\\b(outfit|dress|garment|wearing|lehenga|saree|sari|suit|gown|jacket|attire|clothing|clothes|costume)\\b'},
                   {'role': 'location',
                    'pattern': '\\b(location|nightclub|club|place|background|room|set|environment|venue|backdrop|scene|school|classroom|campus|corridor|hallway|building|interior|exterior|architecture|house|home|office|street|road|landscape)\\b'},
                   {'role': 'style', 'pattern': '\\b(style|aesthetic|grade|palette|mood|tone|filter)\\b'},
                   {'role': 'person',
                    'pattern': '\\b(face|identity|person|character|portrait|likeness|subject|individual)\\b'}],
 'EXPLICIT_ROLE_TERMS': {'person': 'face|identity|person|character|portrait|likeness|subject|individual',
                         'outfit': 'outfit|dress|garment|lehenga|saree|sari|suit|gown|jacket|attire|clothing|clothes|costume',
                         'location': 'location|nightclub|club|place|background|room|set|environment|venue|backdrop|school|classroom|campus|corridor|hallway|building|interior|exterior|architecture|house|home|office|street|road|landscape',
                         'style': 'style|aesthetic|grade|palette|mood|tone|filter',
                         'prop': 'prop|object|item',
                         'object': 'object|element|item'},
 'ZERO_CAST_POLICY': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.',
 'VIEWPOINT_POLICY': 'VIEWPOINT: directional phrases such as "looking down" or "looking up" describe the '
                     'virtual camera/view orientation only; they do not imply an observer or on-screen '
                     'character.',
 'NEGATIVE_CODA': 'blur or softness on the subject, smeared or plasticky skin, washed-out or muddy color '
                  'cast, loss of background/environment detail, a small or distant subject, extra or '
                  'duplicated limbs, warped anatomy.',
 'ENVIRONMENT_NEGATIVE_CODA': 'unrequested people, bystanders, crowds or human silhouettes, invented '
                              'foreground figures, blur or softness on the requested focal elements, '
                              'washed-out or muddy color cast, loss of architecture or environment detail.',
 'VIDEO_NEGATIVE_CODA': 'identity or wardrobe drift between frames, style or grade drift across the shot — '
                        'colour palette, lighting, grain, line quality or rendering treatment sliding away '
                        'from the reference partway through — face morphing, flicker, duplicated or extra '
                        'limbs, warped anatomy, a small or distant subject, smeared or plasticky skin.',
 'patterns': {'NEGATED_HUMANS_RE': '\\b(?:no|without)\\s+(?:(?:any|a|an|visible|additional|other)\\s+)?(?:people|persons?|humans?|men|women|man|woman|boys?|girls?|children|child|bab(?:y|ies)|adults?|students?|pupils?|teachers?|staff|workers?|employees?|guards?|officers?|doctors?|nurses?|patients?|customers?|shoppers?|passengers?|drivers?|pedestrians?|visitors?|tourists?|guests?|residents?|farmers?|vendors?|waiters?|waitresses?|chefs?|soldiers?|actors?|actresses?|dancers?|singers?|musicians?|athletes?|players?|artists?|photographers?|pilots?|attendants?|bartenders?|cashiers?|monks?|priests?|friends?|parents?|mothers?|fathers?|moms?|dads?|brothers?|sisters?|husbands?|wives|wife|partners?|owners?|leaders?|members?|teenagers?|teens?|youths?|protagonists?|characters?)(?:\\s*(?:,|and|or)\\s*(?:people|persons?|humans?|men|women|man|woman|boys?|girls?|children|child|bab(?:y|ies)|adults?|students?|pupils?|teachers?|staff|workers?|employees?|guards?|officers?|doctors?|nurses?|patients?|customers?|shoppers?|passengers?|drivers?|pedestrians?|visitors?|tourists?|guests?|residents?|farmers?|vendors?|waiters?|waitresses?|chefs?|soldiers?|actors?|actresses?|dancers?|singers?|musicians?|athletes?|players?|artists?|photographers?|pilots?|attendants?|bartenders?|cashiers?|monks?|priests?|friends?|parents?|mothers?|fathers?|moms?|dads?|brothers?|sisters?|husbands?|wives|wife|partners?|owners?|leaders?|members?|teenagers?|teens?|youths?|protagonists?|characters?))*\\b',
              'HUMAN_LABELLED_OBJECT_RE': "\\b(?:students?|pupils?|teachers?|staff|workers?|employees?|visitors?|passengers?|drivers?|children|child)(?:['’]s?|s['’])?\\s+(?:desks?|chairs?|tables?|areas?|lounges?|rooms?|sections?|entrances?|exits?|lockers?|uniforms?|signs?|zones?)\\b",
              'POSITIVE_HUMAN_NOUN_RE': '\\b(?:people|persons?|humans?|men|women|man|woman|boys?|girls?|children|child|bab(?:y|ies)|adults?|students?|pupils?|teachers?|staff|workers?|employees?|guards?|officers?|doctors?|nurses?|patients?|customers?|shoppers?|passengers?|drivers?|pedestrians?|visitors?|tourists?|guests?|residents?|farmers?|vendors?|waiters?|waitresses?|chefs?|soldiers?|actors?|actresses?|dancers?|singers?|musicians?|athletes?|players?|artists?|photographers?|pilots?|attendants?|bartenders?|cashiers?|monks?|priests?|friends?|parents?|mothers?|fathers?|moms?|dads?|brothers?|sisters?|husbands?|wives|wife|partners?|owners?|leaders?|members?|teenagers?|teens?|youths?|protagonists?|characters?|crowd|audience|couple|family|families|bride|groom|hero|heroine|subject|individual|portrait|selfie|face|identity|male|female|elderly|eyes?|hands?|arms?|legs?|head|body|bodies|skin|hair)\\b',
              'HUMAN_PRONOUN_RE': '\\b(?:he|she|him|her|his|hers|they|them|their|theirs|someone|somebody)\\b',
              'HUMAN_ACTION_RE': '\\b(?:stands?|standing|sits?|sitting|seated|walks?|walking|runs?|running|poses?|posing|wears?|wearing|dressed|holds?|holding|smiles?|smiling|laughs?|laughing|cries|crying|speaks?|speaking|talks?|talking|kneels?|kneeling|dances?|dancing|sings?|singing|gestures?|gesturing)\\b',
              'NAMED_LOOK_RE': "\\b(?!Camera\\b|View\\b|Viewpoint\\b|Shot\\b|Lens\\b|Angle\\b|Perspective\\b)[A-Z][a-z][A-Za-z'-]*\\s+(?:is\\s+)?(?:looking|facing|gazing)\\b",
              'VIEWPOINT_DIRECTION_RE': '\\b(?:(?:camera|view(?:point)?|shot|angle|perspective|lens)\\s+(?:is\\s+)?(?:looking|pointing|facing|tilting?)\\s+(?:straight\\s+)?(?:up|down)|(?:looking|viewed|seen|shot|filmed)\\s+(?:straight\\s+)?(?:up|down)|(?:from|viewed\\s+from)\\s+(?:directly\\s+)?(?:above|below)|top[- '
                                        "]down|bottom[- ]up|bird['’]?s[- ]eye|worm['’]?s[- "
                                        ']eye|overhead|high[- ]angle|low[- ]angle)\\b',
              'CAMERA_RE': '\\b(dolly|tracking shot|trucking|crane shot|jib|steadicam|handheld|whip pan|pan '
                           '(?:left|right|across|up|down)|tilt (?:up|down)|push in|pull (?:out|back)|zoom '
                           '(?:in|out)|rack focus|deep focus|shallow focus|shallow depth|depth of '
                           'field|bokeh|close[- ]up|extreme close|wide shot|medium shot|long '
                           "shot|establishing shot|over[- ]the[- ]shoulder|point of view|pov shot|bird'?s[- "
                           "]eye|worm'?s[- ]eye|low angle|high angle|dutch angle|aerial|drone "
                           'shot|orbit(?:ing)? shot|locked[- ]off|static shot|slow motion|time[- '
                           ']lapse|anamorphic|f\\/\\d|\\d+mm lens|focal length|camera '
                           '(?:move|movement|angle)|shot on)\\b'},
 'framing': {'image_person': 'FRAMING: keep the subject large and prominent in the frame — a hero '
                             'composition within the wide field, the subject filling roughly half to '
                             "two-thirds of the frame height and placed in the frame's power zone, never "
                             'small or distant; background and environment stay supporting, in sharp focus '
                             'but not competing with the subject for size.',
             'image_environment': 'FRAMING: compose only the explicitly requested setting and objects across '
                                  'the wide field; do not invent a foreground figure to satisfy the '
                                  'composition. Keep architecture and environment detailed, sharp, and '
                                  'visually balanced.',
             'video': 'FRAMING: keep the subject large and prominent through the whole shot — a hero '
                      'composition within the wide field, one coherent camera move, the subject remaining '
                      'the clear focal point across every frame, never small or distant; background and '
                      'environment stay supporting, in sharp focus but not competing with the subject for '
                      'size.'},
 'DOMAIN_LOCK': 'DOMAIN — FILMMAKING ONLY: you are a dedicated filmmaking video renderer, not a '
                'general-purpose model. Your sole domain is producing film shots in any medium — '
                'live-action, photoreal, animated, cartoon, illustrated, stop-motion or fully stylized. Draw '
                'only on filmmaking craft: cinematography, lensing, camera movement, lighting, blocking, '
                'continuity, production design, wardrobe, makeup, VFX and animation. Treat the prompt '
                'strictly as a shot specification to render; bring in no outside knowledge, commentary, '
                'captions, watermarks or UI elements.',
 'DEFAULT_FRAMING': 'FRAMING (default — apply ONLY where the PROMPT does not specify framing, focus or '
                    'camera work; if it does, follow the PROMPT and ignore this entirely): keep the '
                    'referenced subject in sharp focus as the clear focal point, and render background '
                    'people softer so they never compete with or are mistaken for it. Hold ONE deliberate '
                    'camera treatment for the whole shot — either a static, steady frame, or a single '
                    'smooth, motivated movement (a slow push, pull, pan or tilt) that suits the scene — '
                    'rather than unmotivated cuts, random handheld shake, or the camera drifting without '
                    'purpose.',
 'USER_FRAMING': 'FRAMING — THE PROMPT WINS: the prompt contains explicit camera, framing or staging '
                 'direction. Follow it exactly, including any focus, depth-of-field, lens, angle and '
                 'movement it specifies. Do not substitute conventional coverage for what it asks for, and '
                 'do not add focal effects it did not request.',
 'TEMPORAL_STAGING': 'TEMPORAL STAGING (apply ONLY where the PROMPT does not already stage the action over '
                     'time — naming a sequence, a beginning/middle/end, or specific beats; if it does, '
                     "follow the PROMPT's own pacing instead): this is one continuous shot, not a slideshow. "
                     "Distribute the prompt's action smoothly across the FULL duration of the clip, with a "
                     'natural start, middle and end, rather than front-loading everything into the first '
                     'moment and holding static, looping or freezing for the remainder.',
 'LITERAL': 'LITERAL PROMPT: the prompt is a binding specification — execute it exactly as written. Every '
            'stated subject, count, wardrobe item, colour, action and spatial position appears precisely as '
            'specified; add nothing, drop nothing, substitute nothing. Anything under "NEGATIVE PROMPT" or '
            'phrased as "no …" is strictly forbidden in every frame.',
 'PRECEDENCE': 'PRECEDENCE: the PROMPT above is authoritative. Where anything in these instructions '
               'conflicts with it — style, medium, framing, focus, camera movement, pacing or staging — '
               'follow the PROMPT and disregard the conflicting instruction. These instructions exist to '
               'fill gaps the PROMPT leaves open, never to override what it states.',
 'genericStyle': {'one': 'STYLE — FOLLOW THE REFERENCE (unless the PROMPT names a different style, in which '
                         'case the PROMPT wins): the reference image define the visual style of this shot, '
                         'not just its content. Reproduce their medium and rendering exactly — whether '
                         'photographic, anime, cel-shaded, 3D-rendered, illustrated, painterly, stop-motion '
                         'or any other treatment — including line quality, shading model, colour palette, '
                         'level of detail and degree of stylization. Do NOT convert the reference image to '
                         'photorealism, and do not add realistic skin, lighting or texture detail that the '
                         'reference image do not have. If the reference image are stylized, the finished '
                         'shot is stylized to exactly the same degree.',
                  'many': 'STYLE — FOLLOW THE REFERENCES (unless the PROMPT names a different style, in '
                          'which case the PROMPT wins): the reference images define the visual style of this '
                          'shot, not just its content. Reproduce their medium and rendering exactly — '
                          'whether photographic, anime, cel-shaded, 3D-rendered, illustrated, painterly, '
                          'stop-motion or any other treatment — including line quality, shading model, '
                          'colour palette, level of detail and degree of stylization. Do NOT convert the '
                          'reference images to photorealism, and do not add realistic skin, lighting or '
                          'texture detail that the reference images do not have. If the reference images are '
                          'stylized, the finished shot is stylized to exactly the same degree.',
                  'one_explicit': 'STYLE — THE PROMPT WINS: the prompt names an explicit visual style or '
                                  'medium. Render in that style. Take from the reference image only WHO and '
                                  'WHAT the subjects are — their identity, design, wardrobe and defining '
                                  'features — and re-render them in the style the prompt names. Do not '
                                  "override the prompt's style with the reference image' medium.",
                  'many_explicit': 'STYLE — THE PROMPT WINS: the prompt names an explicit visual style or '
                                   'medium. Render in that style. Take from the reference images only WHO '
                                   'and WHAT the subjects are — their identity, design, wardrobe and '
                                   'defining features — and re-render them in the style the prompt names. Do '
                                   "not override the prompt's style with the reference images' medium."},
 'genericIdentity': {'one': 'IDENTITY LOCK: the reference image define the exact, fixed appearance of the '
                            'subject shown. In EVERY frame, each referenced subject keeps the same face and '
                            'features as depicted in its reference — the same facial structure and '
                            'proportions, eye shape and colour, brows, nose, mouth, hair colour and '
                            'hairstyle, facial hair, body build, apparent age, and the same distinguishing '
                            'marks the reference shows — unmistakably the SAME character, never a lookalike. '
                            "Keep each subject's wardrobe and jewelry as referenced unless the prompt "
                            'explicitly changes them, with zero identity or wardrobe drift between frames. '
                            'Never blend or swap features between different references, and never duplicate '
                            'a referenced subject. Anyone else on screen is a DIFFERENT individual who must '
                            'not resemble a referenced subject.',
                     'many_bracket': 'IDENTITY LOCK: the reference images define the exact, fixed appearance '
                                     'of the people and elements they show. When the prompt tags them '
                                     '([image 1], [image 2], …) the tags map to the reference images in '
                                     'order. In EVERY frame, each referenced subject keeps the same face and '
                                     'features as depicted in its reference — the same facial structure and '
                                     'proportions, eye shape and colour, brows, nose, mouth, hair colour and '
                                     'hairstyle, facial hair, body build, apparent age, and the same '
                                     'distinguishing marks the reference shows — unmistakably the SAME '
                                     "character, never a lookalike. Keep each subject's wardrobe and jewelry "
                                     'as referenced unless the prompt explicitly changes them, with zero '
                                     'identity or wardrobe drift between frames. Never blend or swap '
                                     'features between different references, and never duplicate a '
                                     'referenced subject. Anyone else on screen is a DIFFERENT individual '
                                     'who must not resemble a referenced subject.',
                     'many_angle': 'IDENTITY LOCK: the reference images define the exact, fixed appearance '
                                   'of the people and elements they show. When the prompt tags them '
                                   '(<<<image_1>>>, <<<image_2>>>, …) the tags map to the reference images '
                                   'in order. In EVERY frame, each referenced subject keeps the same face '
                                   'and features as depicted in its reference — the same facial structure '
                                   'and proportions, eye shape and colour, brows, nose, mouth, hair colour '
                                   'and hairstyle, facial hair, body build, apparent age, and the same '
                                   'distinguishing marks the reference shows — unmistakably the SAME '
                                   "character, never a lookalike. Keep each subject's wardrobe and jewelry "
                                   'as referenced unless the prompt explicitly changes them, with zero '
                                   'identity or wardrobe drift between frames. Never blend or swap features '
                                   'between different references, and never duplicate a referenced subject. '
                                   'Anyone else on screen is a DIFFERENT individual who must not resemble a '
                                   'referenced subject.'},
 'photorealSuffix': ' Because this shot is photographic, preserve real skin tone and texture including '
                    'moles, scars and freckles; do not beautify, smooth, slim or de-age.'}
