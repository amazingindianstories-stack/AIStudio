"""Local face detection for reference images (OpenCV YuNet, runs on CPU in the worker).

Used to decide which references must become BytePlus portrait assets before a
Seedance submission (BytePlus rejects photoreal faces sent as raw images). No
image leaves our servers for this check. Errors fail closed (treated as a face):
registering a non-face costs one pool slot, sending a face raw costs a rejected
generation.
"""
import hashlib
import io
from pathlib import Path

MODEL_PATH = Path(__file__).with_name('data') / 'face_detection_yunet_2023mar.onnx'
MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
DETECTOR_VERSION = 'yunet-2023mar-v1'
SCORE_THRESHOLD = 0.6
DETECT_LONG_SIDE = 640
MIN_FACE_FRACTION = 0.03     # ignore specks smaller than 3% of the image's short side
MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 40_000_000
_verified = False


def _model_path():
    global _verified
    if not _verified:
        digest = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
        if digest != MODEL_SHA256:
            raise RuntimeError('Face detection model does not match its pinned checksum.')
        _verified = True
    return str(MODEL_PATH)


def _decode(data):
    from PIL import Image, ImageOps
    if not isinstance(data, (bytes, bytearray)) or not data or len(data) > MAX_INPUT_BYTES:
        raise ValueError('image missing or too large')
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > MAX_PIXELS:
            raise ValueError('image has too many pixels')
        image = ImageOps.exif_transpose(image).convert('RGB')
        scale = min(1.0, DETECT_LONG_SIDE / max(image.size))
        if scale < 1.0:
            image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))))
        return image


def detect_faces(data):
    """Return [(x, y, w, h, score)] in the (possibly downscaled) detection frame."""
    import cv2
    import numpy
    image = _decode(data)
    frame = cv2.cvtColor(numpy.asarray(image), cv2.COLOR_RGB2BGR)
    height, width = frame.shape[:2]
    detector = cv2.FaceDetectorYN.create(_model_path(), '', (width, height), SCORE_THRESHOLD, 0.3, 50)
    _, faces = detector.detect(frame)
    minimum = MIN_FACE_FRACTION * min(width, height)
    found = []
    for face in (faces if faces is not None else []):
        x, y, w, h, score = float(face[0]), float(face[1]), float(face[2]), float(face[3]), float(face[-1])
        if score >= SCORE_THRESHOLD and min(w, h) >= minimum:
            found.append((round(x), round(y), round(w), round(h), round(score, 3)))
    return found


def scan(data):
    """{'has_face': bool, 'faces': int, 'error': str|None} — fails closed to has_face=True."""
    try:
        faces = detect_faces(data)
        return {'has_face': bool(faces), 'faces': len(faces), 'error': None}
    except Exception as error:  # decode/model failure: treat as a face
        return {'has_face': True, 'faces': 0, 'error': type(error).__name__}
