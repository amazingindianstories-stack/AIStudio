"""A chat message body's content and reference image refs, validated before anything is stored."""
from apps.generation.watermark import WHITESPACE


def parse_message_body(body):
    content = body.get('content').strip(WHITESPACE) if isinstance(body.get('content'), str) else ''
    if not content:
        return {'error': 'content is required.'}
    if len(content.encode('utf-16-le', errors='surrogatepass')) // 2 > 8000:
        return {'error': 'Message is too long (max 8000 characters).'}
    if 'images' in body and not isinstance(body['images'], list):
        return {'error': 'images must be an array of data URLs.'}
    images = [value for value in body.get('images', []) if isinstance(value, str)]
    if len(images) > 10:
        return {'error': 'Attach at most 10 reference images per message.'}
    return {'content': content, 'images': images}
