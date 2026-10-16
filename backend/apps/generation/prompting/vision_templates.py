"""Golden Node vision instruction strings; no executable JavaScript."""
T = {'candidateJudge': 'Score IMAGE 2 on three axes and answer JSON: {"identity": 0-100, "prominence": 0-100, '
                   '"sharpness": 0-100}. "identity": compare the main character\'s face in IMAGE 2 to IMAGE '
                   '1 like a forensic examiner — bone structure, jawline, eye shape/spacing, eyebrows, nose, '
                   'lips, face shape, apparent age; 100 = unmistakably the SAME person, 50 = '
                   'related-looking, 0 = a different person. "prominence": how large, near-camera and '
                   "centered the main subject's face is within IMAGE 2's frame; 100 = a large, clearly "
                   'framed hero subject, 0 = tiny/distant/barely visible. "sharpness": how crisp and '
                   "in-focus the main subject's FACE region specifically is (not the whole frame — ignore "
                   'background blur/grain); 100 = tack sharp facial detail, 0 = soft/blurred/smeared face.',
 'identityDetection': 'You are helping build a face-identity pipeline. Look at this image and answer as '
                      'JSON: {"person_reference": <bool>, "face_box_2d": [ymin, xmin, ymax, xmax] | null, '
                      '"panel_boxes": [[ymin, xmin, ymax, xmax], ...] | null}. "person_reference" is true if '
                      'the image is primarily a reference of ONE specific person — a portrait, headshot, '
                      'character sheet, or a photo whose clear main subject is a single person. IMPORTANT: '
                      'Even if the image is a character sheet where some panels have faces blanked out, '
                      'hidden, or anonymized (e.g. with white boxes), if there is AT LEAST ONE clear, '
                      'visible face of the subject in any panel, "person_reference" MUST be true. It is '
                      'false ONLY for locations, sets, crowds, objects, style frames, or images where ALL '
                      'faces are hidden/anonymized. When true, "face_box_2d" is the tight bounding box of '
                      "that person's CLEAR face (largest/clearest instance if shown multiple times; ignore "
                      'blanked out faces). "panel_boxes" applies ONLY when the image is a character sheet / '
                      'collage of several distinct panels showing the same person (e.g. front view, profile, '
                      'full body): give one box per panel (even if the face is blanked out in that panel), '
                      'up to 4, most identity-relevant first; otherwise null. All coordinates normalized to '
                      '0-1000.',
 'identityJudge': "Compare the main character's face in IMAGE 2 to IMAGE 1 like a forensic examiner: bone "
                  'structure, jawline, eye shape/spacing, eyebrows, nose, lips, face shape, apparent age. '
                  'Answer JSON: {"identity": 0-100} where 100 = unmistakably the SAME person, 50 = '
                  'related-looking, 0 = a different person.',
 'roleDetection': 'Classify the PRIMARY subject of this reference image for a photo generation pipeline. '
                  'Answer JSON: {"role": "person"|"outfit"|"location"|"style"|"prop"|"object"}. "person" = '
                  "the main subject is a specific individual's face/identity (portrait, headshot, character "
                  'sheet). "outfit" = the main subject is clothing/garments/jewelry meant to be worn, not a '
                  'specific person\'s identity. "location" = a place, set, room, venue or backdrop. "style" '
                  '= a mood board / color palette / lighting or rendering reference, not a concrete scene or '
                  'object. "prop" = a specific physical object meant to be reproduced (e.g. a car, a phone, '
                  'a piece of furniture). "object" = none of the above fit clearly.',
 'subjectMany': 'SUBJECT — 2 reference images of the SAME person (different angles/lighting). Reconstruct '
                "ONE consistent identity from all of them; the generated person's face MUST match exactly — "
                'same bone structure, jawline, hairline, eye shape/spacing and color, eyebrows, nose, lips, '
                'facial hair and apparent age, and where the references are photographic also their skin '
                'tone/texture (keep moles, scars, freckles). Keep their hairstyle, build and worn '
                'outfit/jewelry unless the SCENE explicitly changes them, and render in the same medium and '
                'style as the references. A recognizable match, never a lookalike — never beautified or '
                'idealized relative to the references:',
 'subjectOne': "SUBJECT — reference image of the person. The generated person's face MUST be this exact same "
               'individual — same bone structure, jawline, hairline, eye shape/spacing and color, eyebrows, '
               'nose, lips, facial hair and apparent age, and where the reference is photographic also their '
               'skin tone/texture (keep moles, scars, freckles). Keep their hairstyle, build and worn '
               'outfit/jewelry unless the SCENE explicitly changes them, and render in the same medium and '
               'style as the reference. A recognizable match, not a lookalike — never beautified or '
               'idealized relative to the reference:'}
