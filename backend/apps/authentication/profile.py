"""Current profile contract, including upload cleanup and session-version CAS."""
import base64
import json
import re

from django.db import transaction
from rest_framework.response import Response

from apps.common.responses import clear_session, log_activity, public_user, renew_session
from .models import User
from .session import lookup

ALLOWED_AVATAR_TYPES = {'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
                       'image/gif', 'image/avif', 'image/tiff', 'image/heif', 'image/heic'}
JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def validate_name(value):
    from apps.media.avatars import InvalidAvatarError
    if not isinstance(value, str):
        raise InvalidAvatarError('Name is required.')
    name = value.strip(JS_WHITESPACE)
    if not name:
        raise InvalidAvatarError('Name cannot be empty.')
    if len(name.encode('utf-16-le', errors='surrogatepass')) // 2 > 80:
        raise InvalidAvatarError('Name must be 80 characters or fewer.')
    if re.search(r'[\x00-\x1f\x7f]', name):
        raise InvalidAvatarError('Name cannot contain control characters.')
    return name


def read_update(request):
    from apps.media.avatars import InvalidAvatarError, MAX_AVATAR_UPLOAD_BYTES
    result = {}

    def file_bytes(data, mime):
        if mime.lower() not in ALLOWED_AVATAR_TYPES:
            raise InvalidAvatarError('Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.')
        if not data:
            raise InvalidAvatarError('The selected image is empty.')
        if len(data) > MAX_AVATAR_UPLOAD_BYTES:
            raise InvalidAvatarError('Profile images must be 3 MB or smaller.')
        return data

    content_type = request.content_type.lower()
    if content_type.startswith('multipart/form-data'):
        # QueryDict.get returns the last item; FormData.get returns the first.
        form = request.data
        first = lambda key: form.getlist(key)[0] if form.getlist(key) else None
        if 'name' in form:
            result['name'] = validate_name(first('name'))
        if first('removeAvatar') == 'true':
            result['avatar'] = None
        elif 'avatar' in form:
            avatar = first('avatar')
            if not hasattr(avatar, 'read'):
                raise InvalidAvatarError('Choose an image to upload.')
            result['avatar'] = file_bytes(avatar.read(MAX_AVATAR_UPLOAD_BYTES + 1), avatar.content_type)
    elif content_type.startswith('application/json'):
        try:
            body = json.loads(request.body)
        except (ValueError, UnicodeError):
            body = None
        if not isinstance(body, (dict, list)):
            raise InvalidAvatarError('Invalid profile update.')
        if isinstance(body, list):
            body = {}
        if 'name' in body:
            result['name'] = validate_name(body['name'])
        if ('avatar' in body and body['avatar'] is None) or body.get('removeAvatar') is True:
            result['avatar'] = None
        elif 'avatar' in body:
            data_url = body['avatar']
            if not isinstance(data_url, str):
                raise InvalidAvatarError('An image data URL is required.')
            if len(data_url) > (MAX_AVATAR_UPLOAD_BYTES * 4 + 2) // 3 + 1024:
                raise InvalidAvatarError('Profile images must be 3 MB or smaller.')
            match = re.fullmatch(r'data:([^;,]+);base64,([a-zA-Z0-9+/]+={0,2})', data_url, re.S)
            if not match or match[1].lower() not in ALLOWED_AVATAR_TYPES:
                raise InvalidAvatarError('Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.')
            encoded = match[2].rstrip('=')
            # Node Buffer.from tolerates an incomplete final sextet.
            if len(encoded) % 4 == 1:
                encoded = encoded[:-1]
            data = base64.b64decode(encoded + '=' * (-len(encoded) % 4))
            result['avatar'] = file_bytes(data, match[1])
    else:
        raise InvalidAvatarError('Send profile data as JSON or multipart form data.')
    if not result:
        raise InvalidAvatarError('Nothing to update.')
    return result


def update_profile(request):
    from apps.media.avatars import InvalidAvatarError, save_avatar_image, delete_avatar_image
    session = lookup(request)
    if session is None:
        return clear_session(Response({'error': 'UNAUTHENTICATED'}, status=401))
    try:
        update = read_update(request)
    except Exception as error:
        message = str(error) if isinstance(error, InvalidAvatarError) else 'Invalid profile update.'
        return renew_session(request, Response({'error': message}, status=400))
    changed = []
    values = {}
    if 'name' in update and update['name'] != session.name:
        values['name'] = update['name']
        changed.append('name')
    uploaded = None
    try:
        if 'avatar' in update:
            if update['avatar'] is not None:
                uploaded = save_avatar_image(update['avatar'])
                values['avatar_url'] = uploaded
                changed.append('avatar')
            else:
                values['avatar_url'] = None
                if session.avatar_url is not None:
                    changed.append('avatar')
        if not changed:
            return renew_session(request, Response({'error': 'Nothing to update.'}, status=400))
        with transaction.atomic():
            updated = User.objects.filter(id=session.id, is_active=True,
                                          auth_version=session.auth_version).update(**values)
            account = User.objects.get(id=session.id) if updated else None
        if account is None:
            delete_avatar_image(uploaded)
            return clear_session(Response({'error': 'UNAUTHENTICATED'}, status=401))
        if 'avatar' in update and session.avatar_url != account.avatar_url:
            delete_avatar_image(session.avatar_url)
        log_activity(session.id, 'profile_updated', {'changedFields': changed})
        return renew_session(request, Response({'user': public_user(account)}))
    except Exception as error:
        # A commit can succeed even if its acknowledgement is lost. Never
        # remove an avatar now referenced by a durable user row, and retain it
        # when the database cannot establish whether the upload is orphaned.
        if uploaded:
            try:
                orphaned = not User.objects.filter(avatar_url=uploaded).exists()
            except Exception:
                orphaned = False
            if orphaned:
                delete_avatar_image(uploaded)
        if isinstance(error, InvalidAvatarError):
            return renew_session(request, Response({'error': str(error)}, status=400))
        return renew_session(request, Response({'error': 'Could not update the profile.'}, status=500))
