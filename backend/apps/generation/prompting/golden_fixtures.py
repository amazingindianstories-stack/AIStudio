"""Frozen output hashes from original Node source, evaluated locally with mocked vision."""
GOLDENS = {'video': [{'input': {'prompt': ' A woman turns. ',
                      'refCount': 0,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'e7806d19f205e0f708cbf5d0c377465aa4ec40eed3fac226996f1fb039b2a310'},
           {'input': {'prompt': ' A woman turns. ',
                      'refCount': 0,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'e7806d19f205e0f708cbf5d0c377465aa4ec40eed3fac226996f1fb039b2a310'},
           {'input': {'prompt': ' A woman turns. ',
                      'refCount': 1,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'b36d6e7504b9704f3759fafd990e5563193b64a52f5fb31e15f583865f5cea8d'},
           {'input': {'prompt': ' A woman turns. ',
                      'refCount': 1,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '1471d87be701fcff4b6e95bfb5009449854bfd3fab05b8537762b3e4ee68ae76'},
           {'input': {'prompt': ' A woman turns. ',
                      'refCount': 3,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'b36d6e7504b9704f3759fafd990e5563193b64a52f5fb31e15f583865f5cea8d'},
           {'input': {'prompt': ' A woman turns. ',
                      'refCount': 3,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '1471d87be701fcff4b6e95bfb5009449854bfd3fab05b8537762b3e4ee68ae76'},
           {'input': {'prompt': 'Wide establishing shot in deep focus.',
                      'refCount': 0,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '8f85b60e2bb28c1e19f40eb6e3e085156f0f8651073798a8b765801c19f0614a'},
           {'input': {'prompt': 'Wide establishing shot in deep focus.',
                      'refCount': 0,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '8f85b60e2bb28c1e19f40eb6e3e085156f0f8651073798a8b765801c19f0614a'},
           {'input': {'prompt': 'Wide establishing shot in deep focus.',
                      'refCount': 1,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '5100e921418527a52ab354f0b7ce8bd5e30ad5616030ab95a9ebcc49ff4d305c'},
           {'input': {'prompt': 'Wide establishing shot in deep focus.',
                      'refCount': 1,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '8bcbebd6665a76c1f10bc273f0e63d5b17a4c8e4b0d39827322a26c51688daed'},
           {'input': {'prompt': 'Wide establishing shot in deep focus.',
                      'refCount': 3,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '5100e921418527a52ab354f0b7ce8bd5e30ad5616030ab95a9ebcc49ff4d305c'},
           {'input': {'prompt': 'Wide establishing shot in deep focus.',
                      'refCount': 3,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '8bcbebd6665a76c1f10bc273f0e63d5b17a4c8e4b0d39827322a26c51688daed'},
           {'input': {'prompt': 'Anime hero @img1 in style from @img2.',
                      'refCount': 0,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '451a9764968277a7f6fc96346088984757b3f63085b24532f0a8cdd3f19c7091'},
           {'input': {'prompt': 'Anime hero @img1 in style from @img2.',
                      'refCount': 0,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '451a9764968277a7f6fc96346088984757b3f63085b24532f0a8cdd3f19c7091'},
           {'input': {'prompt': 'Anime hero @img1 in style from @img2.',
                      'refCount': 1,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '70998c84beaebcaf02bdce68d8a9ea849d0de4750fbeef7501fea529eb54fd09'},
           {'input': {'prompt': 'Anime hero @img1 in style from @img2.',
                      'refCount': 1,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'ed49cd0b40679d38252cdc7acc80a909ca05af6c9a93c9871e88cacb360cfde2'},
           {'input': {'prompt': 'Anime hero @img1 in style from @img2.',
                      'refCount': 3,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'd67659958fbe5726594588ebe4d896c65cf68baf6fb821d293192109c4ae8c7b'},
           {'input': {'prompt': 'Anime hero @img1 in style from @img2.',
                      'refCount': 3,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '73e93e0dd1839ff0a2ae6d52ca8fdf1679c3765f967d75910c6048300e08c5c6'},
           {'input': {'prompt': 'Photorealistic close-up, rack focus.',
                      'refCount': 0,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '971cda3c29a2ce528f465a84340ac30f5629877469f5960d94b3d8f8c0923159'},
           {'input': {'prompt': 'Photorealistic close-up, rack focus.',
                      'refCount': 0,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '971cda3c29a2ce528f465a84340ac30f5629877469f5960d94b3d8f8c0923159'},
           {'input': {'prompt': 'Photorealistic close-up, rack focus.',
                      'refCount': 1,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'bd5f691e8458c296c552b1044ba70dc0707ba5b41757149ea138810ec0ae2f6c'},
           {'input': {'prompt': 'Photorealistic close-up, rack focus.',
                      'refCount': 1,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '8aac8cfcdd8bccd5dacfb2d3cbd810c6cdbf48fbc5ac50384f96b57732e8f1ff'},
           {'input': {'prompt': 'Photorealistic close-up, rack focus.',
                      'refCount': 3,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '605aeb8bd80bc23b91dd72cfa60fcd37d4aa89579c92146338674892fc0fbb96'},
           {'input': {'prompt': 'Photorealistic close-up, rack focus.',
                      'refCount': 3,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '97876ef0e9882122f9509d76112cbf80342cb3dfc668bb1b4649ce3b6652be52'},
           {'input': {'prompt': '@img1 face. Six quiet words separate this. @img2 style.',
                      'refCount': 0,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'fe5cc60f6da03f0512a08d9fb10c7974157322643e2c35551b4cc034f1f91382'},
           {'input': {'prompt': '@img1 face. Six quiet words separate this. @img2 style.',
                      'refCount': 0,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': 'fe5cc60f6da03f0512a08d9fb10c7974157322643e2c35551b4cc034f1f91382'},
           {'input': {'prompt': '@img1 face. Six quiet words separate this. @img2 style.',
                      'refCount': 1,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '8f02658a82184f8be96dbf001eba377b112f5b3626cd4c5aae02e3d785e497db'},
           {'input': {'prompt': '@img1 face. Six quiet words separate this. @img2 style.',
                      'refCount': 1,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '2b4310930c0b1d649d6c067a756cf0280630ae1e849ef849f3ed9b25bdc600f9'},
           {'input': {'prompt': '@img1 face. Six quiet words separate this. @img2 style.',
                      'refCount': 3,
                      'tagSyntax': 'bracket',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '8f02658a82184f8be96dbf001eba377b112f5b3626cd4c5aae02e3d785e497db'},
           {'input': {'prompt': '@img1 face. Six quiet words separate this. @img2 style.',
                      'refCount': 3,
                      'tagSyntax': 'angle',
                      'refRoles': {'1': 'person', '2': 'style', '3': 'location'}},
            'sha256': '2b4310930c0b1d649d6c067a756cf0280630ae1e849ef849f3ed9b25bdc600f9'}],
 'shot': [{'input': {'rawPrompt': 'Empty school, no students or staff.',
                     'medium': 'image',
                     'aspectRatio': '1:1'},
           'sha256': '32fd0ff97da1ec7294d7da14e79a3e8967573b94be7254b5180d3fe30582bdb5'},
          {'input': {'rawPrompt': 'Empty school, no students or staff.',
                     'medium': 'image',
                     'aspectRatio': '16:9'},
           'sha256': '33a26fba4663e91dc5227b3a6d3a5cf4c98ebc799cdce7f53924206167dd1545'},
          {'input': {'rawPrompt': 'Empty school, no students or staff.',
                     'medium': 'video',
                     'aspectRatio': '1:1'},
           'sha256': '7573169d146456611f960ada7f70d8b053730913dafe2af615af997507d504fe'},
          {'input': {'rawPrompt': 'Empty school, no students or staff.',
                     'medium': 'video',
                     'aspectRatio': '16:9'},
           'sha256': '0f5dbe34f0925db1619ac8255d3723a6b4e180e895c3f7190b63ba91f6731419'},
          {'input': {'rawPrompt': "teacher's desk, camera looking down",
                     'medium': 'image',
                     'aspectRatio': '1:1'},
           'sha256': '02a876c87b58b26e42e3cf1de1422442fba343f5e259ab59d795c76922274f7b'},
          {'input': {'rawPrompt': "teacher's desk, camera looking down",
                     'medium': 'image',
                     'aspectRatio': '16:9'},
           'sha256': '7a4384cbc5514ca913331ece4d58dce6f285737fcf93658ef00d227f3fe5a7fa'},
          {'input': {'rawPrompt': "teacher's desk, camera looking down",
                     'medium': 'video',
                     'aspectRatio': '1:1'},
           'sha256': 'dd568716b3aa1e7358eb5e45bd958b5d47a017bdcab95be5c41b68bb980ef572'},
          {'input': {'rawPrompt': "teacher's desk, camera looking down",
                     'medium': 'video',
                     'aspectRatio': '16:9'},
           'sha256': 'f7b778c8da43ad3306b48443bcdfa35bc013adda33274ec65078f5668cce43bf'},
          {'input': {'rawPrompt': 'Naisha looking down', 'medium': 'image', 'aspectRatio': '1:1'},
           'sha256': 'abc3a694fe390097b59fa0a35808aebe889582184f9329cb7d4cc9e557a0c287'},
          {'input': {'rawPrompt': 'Naisha looking down', 'medium': 'image', 'aspectRatio': '16:9'},
           'sha256': '4116c62d0b783e708af4b400792a53059d9ed0333b0a60cfdb86eea6b8590569'},
          {'input': {'rawPrompt': 'Naisha looking down', 'medium': 'video', 'aspectRatio': '1:1'},
           'sha256': '414f617c2f27547e9dba4a89f58380f0898211c13da95c3299c38e4cab47d243'},
          {'input': {'rawPrompt': 'Naisha looking down', 'medium': 'video', 'aspectRatio': '16:9'},
           'sha256': '7d2a5e003a746f6daa539091161f3c3af88a91ca55b7781ba0f917d221ecc551'},
          {'input': {'rawPrompt': 'A woman smiles.', 'medium': 'image', 'aspectRatio': '1:1'},
           'sha256': '865d8439dd00c93676a996cce6750cf3bd7afe1c64c27076e1a15a071d56676f'},
          {'input': {'rawPrompt': 'A woman smiles.', 'medium': 'image', 'aspectRatio': '16:9'},
           'sha256': '20272a31a90bc9709ef4a88ea69ef79d7b7f41fc123216dfc2df8ad304c7a394'},
          {'input': {'rawPrompt': 'A woman smiles.', 'medium': 'video', 'aspectRatio': '1:1'},
           'sha256': 'be759e23d584d4803181dc5eacdd19b8dd7ad9a8560adde40bfbb69a474fea74'},
          {'input': {'rawPrompt': 'A woman smiles.', 'medium': 'video', 'aspectRatio': '16:9'},
           'sha256': 'aec2aa307dae69ee1a1cc5df812c479a47a6a682690e53b662a481f8d21930af'},
          {'input': {'rawPrompt': 'Plain landscape.', 'medium': 'image', 'aspectRatio': '1:1'},
           'sha256': '0417b83d2744cefc6d0a704575a1c3a278d9273623497c72b3cf52c38d22b032'},
          {'input': {'rawPrompt': 'Plain landscape.', 'medium': 'image', 'aspectRatio': '16:9'},
           'sha256': 'bf0631a5e30809e666ba15ad90b3683b29949dfee7aba2195187f49c2b29d088'},
          {'input': {'rawPrompt': 'Plain landscape.', 'medium': 'video', 'aspectRatio': '1:1'},
           'sha256': '990e7d5a36d25aecf2c0700ea102f8b887587cf3cb0caa19cf37069f56ab9503'},
          {'input': {'rawPrompt': 'Plain landscape.', 'medium': 'video', 'aspectRatio': '16:9'},
           'sha256': 'e98da9dc4bb068c379d36bd9d5c3e5c5a5125fa237293fd0e778e3211a384d5a'}],
 'cast': [{'prompt': 'Empty school, no students or staff.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'},
          {'prompt': 'Empty school, no students or staff.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'},
          {'prompt': 'Empty school, no students or staff.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'},
          {'prompt': 'Empty school, no students or staff.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'},
          {'prompt': "teacher's desk, camera looking down",
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.\n'
                     'VIEWPOINT: directional phrases such as "looking down" or "looking up" describe the '
                     'virtual camera/view orientation only; they do not imply an observer or on-screen '
                     'character.'},
          {'prompt': "teacher's desk, camera looking down",
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.\n'
                     'VIEWPOINT: directional phrases such as "looking down" or "looking up" describe the '
                     'virtual camera/view orientation only; they do not imply an observer or on-screen '
                     'character.'},
          {'prompt': "teacher's desk, camera looking down",
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.\n'
                     'VIEWPOINT: directional phrases such as "looking down" or "looking up" describe the '
                     'virtual camera/view orientation only; they do not imply an observer or on-screen '
                     'character.'},
          {'prompt': "teacher's desk, camera looking down",
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.\n'
                     'VIEWPOINT: directional phrases such as "looking down" or "looking up" describe the '
                     'virtual camera/view orientation only; they do not imply an observer or on-screen '
                     'character.'},
          {'prompt': 'Naisha looking down', 'output': None},
          {'prompt': 'Naisha looking down', 'output': None},
          {'prompt': 'Naisha looking down', 'output': None},
          {'prompt': 'Naisha looking down', 'output': None},
          {'prompt': 'A woman smiles.', 'output': None},
          {'prompt': 'A woman smiles.', 'output': None},
          {'prompt': 'A woman smiles.', 'output': None},
          {'prompt': 'A woman smiles.', 'output': None},
          {'prompt': 'Plain landscape.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'},
          {'prompt': 'Plain landscape.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'},
          {'prompt': 'Plain landscape.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'},
          {'prompt': 'Plain landscape.',
           'output': 'CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. Do not invent '
                     'any physically present person, bystander, crowd, camera operator, observer, or human '
                     'silhouette. Any inferred details must be non-human and belong to the requested '
                     'environment.'}],
 'assembler': [{'input': {'prompt': ' Literal\nscene. ', 'uploads': [], 'shot': False},
                'sha256': 'a58298746cbc7b54e7bb88957cffe69ac59253cf5ee940248b289f9b5aac5944'},
               {'input': {'prompt': 'A woman smiles.', 'uploads': ['one'], 'shot': False},
                'sha256': 'a223a8f31606250fa8d9a44291eef3b0d5658cec57cb1fd3ba9a5f9cdd76d608'},
               {'input': {'prompt': 'A woman smiles.', 'uploads': ['one', 'two'], 'shot': False},
                'sha256': '24c22f912bb681370fb4e4abfe464f77541fbfe0c95be4bfce349014f09fe7a1'},
               {'input': {'prompt': '@img1 face and @img2 style', 'uploads': ['one', 'two'], 'shot': False},
                'sha256': '455199408fb92b80551f581ddd3458a474f1b1538aa8515197ec2b1a0d5f369c'},
               {'input': {'prompt': 'empty school from @img1', 'uploads': ['one', 'two'], 'shot': False},
                'sha256': '740ebd46698b52a126c2849733add425a6a798d99861d8a1b34759e57f56408f'},
               {'input': {'prompt': '@img1 looking down in a school', 'uploads': ['one'], 'shot': False},
                'sha256': 'a78f1a1fe845a81858e5222a0a606f00ea563eac4c12a26673f52537866e6738'},
               {'input': {'prompt': ' Literal\nscene. ', 'uploads': [], 'shot': True},
                'sha256': '2bfde554f80ea227ce7ba33f96e10d0d4baa66bd420822f03819456b5222ac32'},
               {'input': {'prompt': 'A woman smiles.', 'uploads': ['one'], 'shot': True},
                'sha256': 'e7910d248a3b263b39c85a3947f8d40c1189f3c382028d2ad2b68dcd96fd2b88'},
               {'input': {'prompt': 'A woman smiles.', 'uploads': ['one', 'two'], 'shot': True},
                'sha256': 'fac1a004f1ef45f16aae69b0cd3deeb7568088904cbd46c4ae1a32213b28eca4'},
               {'input': {'prompt': '@img1 face and @img2 style', 'uploads': ['one', 'two'], 'shot': True},
                'sha256': '8c6ced349a0604f91751de5f0989daabd57826233eb658ad568e663d30a7f221'},
               {'input': {'prompt': 'empty school from @img1', 'uploads': ['one', 'two'], 'shot': True},
                'sha256': 'd8edb0e64c83ede1b87323b67db6793f25240f4ae508f40a547266eb4ae9efbd'},
               {'input': {'prompt': '@img1 looking down in a school', 'uploads': ['one'], 'shot': True},
                'sha256': 'ace715bcc6ca1bdb0e9d60cf5f21bbd3f28b66a258e8bfcb1c7124a54ed4d32a'}]}

SEEDANCE_GOLDENS = [{'input': {'prompt': ' Literal prompt. ',
            'ratio': '16:9',
            'duration': 5,
            'resolution': '720p',
            'modelDisplay': 'Seedance 2.0'},
  'output': {'model': 'dreamina-seedance-2-0-260128',
             'content': [{'type': 'text', 'text': 'Literal prompt.'}],
             'generate_audio': False,
             'bitrate_mode': 'high',
             'ratio': '16:9',
             'duration': 5,
             'resolution': '720p'}},
 {'input': {'prompt': '@img3 face in style from @img1',
            'references': [{'tag': '@img3', 'index': 3, 'dataUrl': 'data:image/png;base64,YQ=='},
                           {'tag': '@img1', 'index': 1, 'dataUrl': 'data:image/png;base64,Yg=='}],
            'generateAudio': True,
            'bitrateMode': 'standard',
            'draftMode': True,
            'seed': 0,
            'modelDisplay': 'Seedance 2.0'},
  'output': {'model': 'dreamina-seedance-2-0-260128',
             'content': [{'type': 'text',
                          'text': 'DOMAIN — FILMMAKING ONLY: you are a dedicated filmmaking video renderer, '
                                  'not a general-purpose model. Your sole domain is producing film shots in '
                                  'any medium — live-action, photoreal, animated, cartoon, illustrated, '
                                  'stop-motion or fully stylized. Draw only on filmmaking craft: '
                                  'cinematography, lensing, camera movement, lighting, blocking, continuity, '
                                  'production design, wardrobe, makeup, VFX and animation. Treat the prompt '
                                  'strictly as a shot specification to render; bring in no outside '
                                  'knowledge, commentary, captions, watermarks or UI elements.\n'
                                  '\n'
                                  'STYLE — FOLLOW THE REFERENCES (unless the PROMPT names a different style, '
                                  'in which case the PROMPT wins): the reference images define the visual '
                                  'style of this shot, not just its content. Reproduce their medium and '
                                  'rendering exactly — whether photographic, anime, cel-shaded, 3D-rendered, '
                                  'illustrated, painterly, stop-motion or any other treatment — including '
                                  'line quality, shading model, colour palette, level of detail and degree '
                                  'of stylization. Do NOT convert the reference images to photorealism, and '
                                  'do not add realistic skin, lighting or texture detail that the reference '
                                  'images do not have. If the reference images are stylized, the finished '
                                  'shot is stylized to exactly the same degree.\n'
                                  '\n'
                                  'IDENTITY LOCK: the reference images define the exact, fixed appearance of '
                                  'the people and elements they show. When the prompt tags them ([image 1], '
                                  '[image 2], …) the tags map to the reference images in order. In EVERY '
                                  'frame, each referenced subject keeps the same face and features as '
                                  'depicted in its reference — the same facial structure and proportions, '
                                  'eye shape and colour, brows, nose, mouth, hair colour and hairstyle, '
                                  'facial hair, body build, apparent age, and the same distinguishing marks '
                                  'the reference shows — unmistakably the SAME character, never a lookalike. '
                                  "Keep each subject's wardrobe and jewelry as referenced unless the prompt "
                                  'explicitly changes them, with zero identity or wardrobe drift between '
                                  'frames. Never blend or swap features between different references, and '
                                  'never duplicate a referenced subject. Anyone else on screen is a '
                                  'DIFFERENT individual who must not resemble a referenced subject.\n'
                                  '\n'
                                  'FRAMING (default — apply ONLY where the PROMPT does not specify framing, '
                                  'focus or camera work; if it does, follow the PROMPT and ignore this '
                                  'entirely): keep the referenced subject in sharp focus as the clear focal '
                                  'point, and render background people softer so they never compete with or '
                                  'are mistaken for it. Hold ONE deliberate camera treatment for the whole '
                                  'shot — either a static, steady frame, or a single smooth, motivated '
                                  'movement (a slow push, pull, pan or tilt) that suits the scene — rather '
                                  'than unmotivated cuts, random handheld shake, or the camera drifting '
                                  'without purpose.\n'
                                  '\n'
                                  'TEMPORAL STAGING (apply ONLY where the PROMPT does not already stage the '
                                  'action over time — naming a sequence, a beginning/middle/end, or specific '
                                  "beats; if it does, follow the PROMPT's own pacing instead): this is one "
                                  "continuous shot, not a slideshow. Distribute the prompt's action smoothly "
                                  'across the FULL duration of the clip, with a natural start, middle and '
                                  'end, rather than front-loading everything into the first moment and '
                                  'holding static, looping or freezing for the remainder.\n'
                                  '\n'
                                  'AVOID: identity or wardrobe drift between frames, style or grade drift '
                                  'across the shot — colour palette, lighting, grain, line quality or '
                                  'rendering treatment sliding away from the reference partway through — '
                                  'face morphing, flicker, duplicated or extra limbs, warped anatomy, a '
                                  'small or distant subject, smeared or plasticky skin.\n'
                                  '\n'
                                  'LITERAL PROMPT: the prompt is a binding specification — execute it '
                                  'exactly as written. Every stated subject, count, wardrobe item, colour, '
                                  'action and spatial position appears precisely as specified; add nothing, '
                                  'drop nothing, substitute nothing. Anything under "NEGATIVE PROMPT" or '
                                  'phrased as "no …" is strictly forbidden in every frame.\n'
                                  '\n'
                                  'PROMPT:\n'
                                  '[image 3] face in style from [image 1]\n'
                                  '\n'
                                  'PRECEDENCE: the PROMPT above is authoritative. Where anything in these '
                                  'instructions conflicts with it — style, medium, framing, focus, camera '
                                  'movement, pacing or staging — follow the PROMPT and disregard the '
                                  'conflicting instruction. These instructions exist to fill gaps the PROMPT '
                                  'leaves open, never to override what it states.'},
                         {'type': 'image_url',
                          'image_url': {'url': 'data:image/png;base64,YQ=='},
                          'role': 'reference_image'},
                         {'type': 'image_url',
                          'image_url': {'url': 'data:image/png;base64,Yg=='},
                          'role': 'reference_image'}],
             'generate_audio': True,
             'bitrate_mode': 'standard',
             'seed': 0}},
 {'input': {'prompt': 'First frame',
            'firstFrame': {'url': 'first'},
            'lastFrame': {'url': 'last'},
            'ratio': '9:16',
            'duration': 8,
            'callbackUrl': 'https://app.invalid/callback',
            'modelDisplay': 'Seedance 2.0'},
  'output': {'model': 'dreamina-seedance-2-0-260128',
             'content': [{'type': 'text', 'text': 'First frame'},
                         {'type': 'image_url', 'image_url': {'url': 'first'}, 'role': 'first_frame'},
                         {'type': 'image_url', 'image_url': {'url': 'last'}, 'role': 'last_frame'}],
             'generate_audio': False,
             'bitrate_mode': 'high',
             'callback_url': 'https://app.invalid/callback',
             'ratio': 'adaptive',
             'duration': 8}},
 {'input': {'prompt': ' Literal prompt. ',
            'ratio': '16:9',
            'duration': 5,
            'resolution': '720p',
            'modelDisplay': 'Seedance 2.5'},
  'output': {'model': 'dreamina-seedance-2-5-260628',
             'content': [{'type': 'text', 'text': 'Literal prompt.'}],
             'generate_audio': False,
             'output_format': 'mov',
             'draft': False,
             'bitrate_mode': 'high',
             'ratio': '16:9',
             'duration': 5,
             'resolution': '720p'}},
 {'input': {'prompt': '@img3 face in style from @img1',
            'references': [{'tag': '@img3', 'index': 3, 'dataUrl': 'data:image/png;base64,YQ=='},
                           {'tag': '@img1', 'index': 1, 'dataUrl': 'data:image/png;base64,Yg=='}],
            'generateAudio': True,
            'bitrateMode': 'standard',
            'draftMode': True,
            'seed': 0,
            'modelDisplay': 'Seedance 2.5'},
  'output': {'model': 'dreamina-seedance-2-5-260628',
             'content': [{'type': 'text',
                          'text': 'DOMAIN — FILMMAKING ONLY: you are a dedicated filmmaking video renderer, '
                                  'not a general-purpose model. Your sole domain is producing film shots in '
                                  'any medium — live-action, photoreal, animated, cartoon, illustrated, '
                                  'stop-motion or fully stylized. Draw only on filmmaking craft: '
                                  'cinematography, lensing, camera movement, lighting, blocking, continuity, '
                                  'production design, wardrobe, makeup, VFX and animation. Treat the prompt '
                                  'strictly as a shot specification to render; bring in no outside '
                                  'knowledge, commentary, captions, watermarks or UI elements.\n'
                                  '\n'
                                  'STYLE — FOLLOW THE REFERENCES (unless the PROMPT names a different style, '
                                  'in which case the PROMPT wins): the reference images define the visual '
                                  'style of this shot, not just its content. Reproduce their medium and '
                                  'rendering exactly — whether photographic, anime, cel-shaded, 3D-rendered, '
                                  'illustrated, painterly, stop-motion or any other treatment — including '
                                  'line quality, shading model, colour palette, level of detail and degree '
                                  'of stylization. Do NOT convert the reference images to photorealism, and '
                                  'do not add realistic skin, lighting or texture detail that the reference '
                                  'images do not have. If the reference images are stylized, the finished '
                                  'shot is stylized to exactly the same degree.\n'
                                  '\n'
                                  'IDENTITY LOCK: the reference images define the exact, fixed appearance of '
                                  'the people and elements they show. When the prompt tags them (@Image 1, '
                                  '@Image 2, …) the tags map to the reference images in order. In EVERY '
                                  'frame, each referenced subject keeps the same face and features as '
                                  'depicted in its reference — the same facial structure and proportions, '
                                  'eye shape and colour, brows, nose, mouth, hair colour and hairstyle, '
                                  'facial hair, body build, apparent age, and the same distinguishing marks '
                                  'the reference shows — unmistakably the SAME character, never a lookalike. '
                                  "Keep each subject's wardrobe and jewelry as referenced unless the prompt "
                                  'explicitly changes them, with zero identity or wardrobe drift between '
                                  'frames. Never blend or swap features between different references, and '
                                  'never duplicate a referenced subject. Anyone else on screen is a '
                                  'DIFFERENT individual who must not resemble a referenced subject.\n'
                                  '\n'
                                  'FRAMING (default — apply ONLY where the PROMPT does not specify framing, '
                                  'focus or camera work; if it does, follow the PROMPT and ignore this '
                                  'entirely): keep the referenced subject in sharp focus as the clear focal '
                                  'point, and render background people softer so they never compete with or '
                                  'are mistaken for it. Hold ONE deliberate camera treatment for the whole '
                                  'shot — either a static, steady frame, or a single smooth, motivated '
                                  'movement (a slow push, pull, pan or tilt) that suits the scene — rather '
                                  'than unmotivated cuts, random handheld shake, or the camera drifting '
                                  'without purpose.\n'
                                  '\n'
                                  'TEMPORAL STAGING (apply ONLY where the PROMPT does not already stage the '
                                  'action over time — naming a sequence, a beginning/middle/end, or specific '
                                  "beats; if it does, follow the PROMPT's own pacing instead): this is one "
                                  "continuous shot, not a slideshow. Distribute the prompt's action smoothly "
                                  'across the FULL duration of the clip, with a natural start, middle and '
                                  'end, rather than front-loading everything into the first moment and '
                                  'holding static, looping or freezing for the remainder.\n'
                                  '\n'
                                  'AVOID: identity or wardrobe drift between frames, style or grade drift '
                                  'across the shot — colour palette, lighting, grain, line quality or '
                                  'rendering treatment sliding away from the reference partway through — '
                                  'face morphing, flicker, duplicated or extra limbs, warped anatomy, a '
                                  'small or distant subject, smeared or plasticky skin.\n'
                                  '\n'
                                  'LITERAL PROMPT: the prompt is a binding specification — execute it '
                                  'exactly as written. Every stated subject, count, wardrobe item, colour, '
                                  'action and spatial position appears precisely as specified; add nothing, '
                                  'drop nothing, substitute nothing. Anything under "NEGATIVE PROMPT" or '
                                  'phrased as "no …" is strictly forbidden in every frame.\n'
                                  '\n'
                                  'PROMPT:\n'
                                  '@Image 1 face in style from @Image 2\n'
                                  '\n'
                                  'PRECEDENCE: the PROMPT above is authoritative. Where anything in these '
                                  'instructions conflicts with it — style, medium, framing, focus, camera '
                                  'movement, pacing or staging — follow the PROMPT and disregard the '
                                  'conflicting instruction. These instructions exist to fill gaps the PROMPT '
                                  'leaves open, never to override what it states.'},
                         {'type': 'image_url',
                          'image_url': {'url': 'data:image/png;base64,YQ=='},
                          'role': 'reference_image'},
                         {'type': 'image_url',
                          'image_url': {'url': 'data:image/png;base64,Yg=='},
                          'role': 'reference_image'}],
             'generate_audio': True,
             'output_format': 'mov',
             'omni_reference_task_type': 'reference',
             'draft': True,
             'bitrate_mode': 'standard',
             'seed': 0}},
 {'input': {'prompt': 'First frame',
            'firstFrame': {'url': 'first'},
            'lastFrame': {'url': 'last'},
            'ratio': '9:16',
            'duration': 8,
            'callbackUrl': 'https://app.invalid/callback',
            'modelDisplay': 'Seedance 2.5'},
  'output': {'model': 'dreamina-seedance-2-5-260628',
             'content': [{'type': 'text', 'text': 'First frame'},
                         {'type': 'image_url', 'image_url': {'url': 'first'}, 'role': 'first_frame'},
                         {'type': 'image_url', 'image_url': {'url': 'last'}, 'role': 'last_frame'}],
             'generate_audio': False,
             'output_format': 'mov',
             'draft': False,
             'bitrate_mode': 'high',
             'callback_url': 'https://app.invalid/callback',
             'ratio': 'adaptive',
             'duration': 8}},
 {'input': {'prompt': 'Edit @vid1 with @audio1',
            'taskMode': 'edit',
            'referenceVideoUrls': ['source'],
            'referenceAudioUrls': ['audio'],
            'duration': 9,
            'modelDisplay': 'Seedance 2.5'},
  'output': {'model': 'dreamina-seedance-2-5-260628',
             'content': [{'type': 'text',
                          'text': 'Edit the attached reference video as follows: Edit @Video 1 with @Audio '
                                  '1'},
                         {'type': 'video_url', 'video_url': {'url': 'source'}, 'role': 'reference_video'},
                         {'type': 'audio_url', 'audio_url': {'url': 'audio'}, 'role': 'reference_audio'}],
             'generate_audio': False,
             'output_format': 'mov',
             'omni_reference_task_type': 'edit',
             'draft': False,
             'bitrate_mode': 'high',
             'ratio': 'adaptive',
             'duration': -1}},
 {'input': {'prompt': 'Extend @vid1',
            'taskMode': 'extend',
            'referenceVideoUrls': ['source'],
            'duration': 7,
            'modelDisplay': 'Seedance 2.5'},
  'output': {'model': 'dreamina-seedance-2-5-260628',
             'content': [{'type': 'text',
                          'text': 'Extend the attached reference video forward in time: Extend @Video 1'},
                         {'type': 'video_url', 'video_url': {'url': 'source'}, 'role': 'reference_video'}],
             'generate_audio': False,
             'output_format': 'mov',
             'omni_reference_task_type': 'extend',
             'draft': False,
             'bitrate_mode': 'high',
             'ratio': 'adaptive',
             'duration': 7}},
 {'input': {'modelDisplay': 'Seedance 2.5',
            'draftTaskId': 'draft',
            'prompt': 'ignored',
            'bitrateMode': 'standard',
            'callbackUrl': 'https://app.invalid/callback'},
  'output': {'model': 'dreamina-seedance-2-5-260628',
             'content': [{'type': 'draft_task', 'draft_task': {'id': 'draft'}}],
             'resolution': '1080p',
             'output_format': 'mov',
             'callback_url': 'https://app.invalid/callback'},
  'final': True}]

HIGGSFIELD_GOLDENS = [{'input': {'model': 'Higgsfield Seedance 2.0',
            'prompt': 'Literal text.',
            'mediaIds': [],
            'aspectRatio': '16:9',
            'duration': 8,
            'resolution': '1080P'},
  'output': {'model': 'seedance_2_0',
             'medias': [],
             'prompt': 'Literal text.',
             'aspect_ratio': '16:9',
             'duration': 8,
             'resolution': '1080p'},
  'image': False},
 {'input': {'model': 'Higgsfield Seedance 2.0',
            'prompt': '@img1 face; seven words separate this from its precise style @img2',
            'mediaIds': ['face', 'style'],
            'duration': 5},
  'output': {'model': 'seedance_2_0',
             'medias': [{'value': 'face', 'role': 'image_references'},
                        {'value': 'style', 'role': 'image_references'}],
             'prompt': 'DOMAIN — FILMMAKING ONLY: you are a dedicated filmmaking video renderer, not a '
                       'general-purpose model. Your sole domain is producing film shots in any medium — '
                       'live-action, photoreal, animated, cartoon, illustrated, stop-motion or fully '
                       'stylized. Draw only on filmmaking craft: cinematography, lensing, camera movement, '
                       'lighting, blocking, continuity, production design, wardrobe, makeup, VFX and '
                       'animation. Treat the prompt strictly as a shot specification to render; bring in no '
                       'outside knowledge, commentary, captions, watermarks or UI elements.\n'
                       '\n'
                       'REFERENCES:\n'
                       '<<<image_1>>> = the exact face/identity of the subject — must be reproduced with '
                       'exact fidelity to the reference and in its medium, never a lookalike.\n'
                       '<<<image_2>>> = the exact visual style/grade to match.\n'
                       '\n'
                       'STYLE — FOLLOW THIS TAGGED REFERENCE ONLY (unless the PROMPT names a different '
                       'style, in which case the PROMPT wins): <<<image_2>>> defines the visual style of '
                       'this shot, not just its content. Reproduce its medium and rendering exactly — '
                       'whether photographic, anime, cel-shaded, 3D-rendered, illustrated, painterly, '
                       'stop-motion or any other treatment — including line quality, shading model, colour '
                       'palette, level of detail and degree of stylization. Do NOT take style cues from any '
                       'other tagged reference — the other references define identity, outfit, location or '
                       'subject matter only, never style. Do NOT convert <<<image_2>>> to photorealism, and '
                       'do not add realistic skin, lighting or texture detail it does not have.\n'
                       '\n'
                       'IDENTITY LOCK: this tagged reference — <<<image_1>>> — defines the exact, fixed '
                       'appearance of the people it shows. The other tagged reference (<<<image_2>>> = '
                       'style) contributes only their own content — not an additional face or person. In '
                       'EVERY frame, each person referenced by <<<image_1>>> keeps the same face and '
                       'features as depicted in its reference — the same facial structure and proportions, '
                       'eye shape and colour, brows, nose, mouth, hair colour and hairstyle, facial hair, '
                       'body build, apparent age, and the same distinguishing marks the reference shows — '
                       "unmistakably the SAME character, never a lookalike. Keep that subject's wardrobe and "
                       'jewelry as referenced unless the prompt explicitly changes them, with zero identity '
                       'or wardrobe drift between frames. Never blend or swap features between different '
                       'references, and never duplicate a referenced subject. Anyone else on screen is a '
                       'DIFFERENT individual who must not resemble a referenced subject.\n'
                       '\n'
                       'FRAMING (default — apply ONLY where the PROMPT does not specify framing, focus or '
                       'camera work; if it does, follow the PROMPT and ignore this entirely): keep the '
                       'referenced subject in sharp focus as the clear focal point, and render background '
                       'people softer so they never compete with or are mistaken for it. Hold ONE deliberate '
                       'camera treatment for the whole shot — either a static, steady frame, or a single '
                       'smooth, motivated movement (a slow push, pull, pan or tilt) that suits the scene — '
                       'rather than unmotivated cuts, random handheld shake, or the camera drifting without '
                       'purpose.\n'
                       '\n'
                       'TEMPORAL STAGING (apply ONLY where the PROMPT does not already stage the action over '
                       'time — naming a sequence, a beginning/middle/end, or specific beats; if it does, '
                       "follow the PROMPT's own pacing instead): this is one continuous shot, not a "
                       "slideshow. Distribute the prompt's action smoothly across the FULL duration of the "
                       'clip, with a natural start, middle and end, rather than front-loading everything '
                       'into the first moment and holding static, looping or freezing for the remainder.\n'
                       '\n'
                       'AVOID: identity or wardrobe drift between frames, style or grade drift across the '
                       'shot — colour palette, lighting, grain, line quality or rendering treatment sliding '
                       'away from the reference partway through — face morphing, flicker, duplicated or '
                       'extra limbs, warped anatomy, a small or distant subject, smeared or plasticky skin.\n'
                       '\n'
                       'LITERAL PROMPT: the prompt is a binding specification — execute it exactly as '
                       'written. Every stated subject, count, wardrobe item, colour, action and spatial '
                       'position appears precisely as specified; add nothing, drop nothing, substitute '
                       'nothing. Anything under "NEGATIVE PROMPT" or phrased as "no …" is strictly forbidden '
                       'in every frame.\n'
                       '\n'
                       'PROMPT:\n'
                       '<<<image_1>>> face; seven words separate this from its precise style <<<image_2>>>\n'
                       '\n'
                       'PRECEDENCE: the PROMPT above is authoritative. Where anything in these instructions '
                       'conflicts with it — style, medium, framing, focus, camera movement, pacing or '
                       'staging — follow the PROMPT and disregard the conflicting instruction. These '
                       'instructions exist to fill gaps the PROMPT leaves open, never to override what it '
                       'states.',
             'duration': 5},
  'image': False},
 {'input': {'model': 'Higgsfield Nano Banana Pro',
            'prompt': ' @img2 literal. ',
            'mediaIds': ['one', 'two'],
            'resolution': '2K',
            'quality': 'high',
            'aspectRatio': '1:1'},
  'output': {'model': 'nano_banana_pro',
             'prompt': ' <<<image_2>>> literal. ',
             'aspect_ratio': '1:1',
             'quality': 'high',
             'resolution': '2K',
             'medias': [{'value': 'one', 'role': 'image'}, {'value': 'two', 'role': 'image'}]},
  'image': True},
 {'input': {'model': 'Higgsfield Soul', 'prompt': 'Landscape.', 'mediaIds': []},
  'output': {'model': 'soul_2', 'prompt': 'Landscape.'},
  'image': True}]
