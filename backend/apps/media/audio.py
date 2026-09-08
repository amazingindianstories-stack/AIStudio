import re

AUDIO_MIME = re.compile(r"audio/(mpeg|mp3|wav|x-wav|wave|ogg|webm|mp4|x-m4a|aac|flac)", re.I)
MAX_AUDIO_BYTES = 15 * 1024 * 1024
