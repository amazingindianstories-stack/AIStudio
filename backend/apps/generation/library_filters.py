"""Library predicates and option catalogs over the authorized history source.

Options describe the whole source, never just the first loaded page. Counts are
deliberately absent: these are not disjunctive facet statistics.
"""
import base64
import hashlib
import json
from uuid import UUID

from django.db.models import Q
from django.db.models.functions import Lower, Trim
from rest_framework.exceptions import ValidationError

from .model_registry import model_definition

LISTS = {
    'type': {'image', 'video', 'depth'},
    'model': None,
    'resolution': None,
    'aspect': None,
    'durationBucket': {'short', 'medium', 'long', 'unknown'},
    'stage': {'draft', 'final', 'unknown'},
    'creator': None,
    'status': {'ready', 'creating', 'failed'},
    'bitrate': {'high', 'standard', 'unknown'},
}


def parse_library_filters(params):
    result = {}
    for key, allowed in LISTS.items():
        values = params.getlist(key)
        if len(values) > 50 or any(not value or len(value) > 200 for value in values):
            raise ValidationError({'error': f'Invalid {key} filter.'})
        if allowed is not None and any(value not in allowed for value in values):
            raise ValidationError({'error': f'Invalid {key} filter.'})
        if key == 'creator':
            for value in values:
                if value != 'unknown':
                    try:
                        UUID(value)
                    except ValueError as exc:
                        raise ValidationError({'error': 'Invalid creator filter.'}) from exc
        if key == 'resolution':
            for value in values:
                kind, separator, setting = value.partition(':')
                if not separator or kind not in ('image', 'video', 'depth') or not setting or len(setting) > 40:
                    raise ValidationError({'error': 'Invalid resolution filter.'})
        if values:
            result[key] = sorted(set(values))
    for key in ('createdFrom', 'createdBefore'):
        raw = params.get(key)
        if raw is not None:
            digits = raw[1:] if raw.startswith('-') else raw
            if len(raw) > 17 or not raw.isascii() or not digits.isdecimal() or abs(int(raw)) > 8640000000000000:
                raise ValidationError({'error': 'Invalid date range.'})
            result[key] = int(raw)
    if 'createdFrom' in result and 'createdBefore' in result and result['createdFrom'] >= result['createdBefore']:
        raise ValidationError({'error': 'Start date must precede the end of the range.'})
    sort = params.get('sort')
    if sort is not None:
        if sort not in ('newest', 'oldest', 'starred'):
            raise ValidationError({'error': 'Invalid library sort.'})
        if sort == 'starred' and params.get('favorite') != '1':
            raise ValidationError({'error': 'Recently starred requires Favourites.'})
        result['sort'] = sort
    return result


def canonical_model(value):
    model = model_definition(value)
    return model['id'] if model else value


def apply_library_filters(rows, filters):
    for key, field in (('type', 'kind'), ('aspect', 'aspect_ratio')):
        if filters.get(key):
            rows = rows.filter(**{field + '__in': filters[key]})
    if filters.get('model'):
        predicate = Q(pk__in=[])
        for value in filters['model']:
            model = model_definition(value)
            predicate |= Q(model__iexact=model['name']) | Q(model=model['id']) if model else Q(model=value)
        rows = rows.filter(predicate)
    if filters.get('resolution'):
        rows = rows.alias(library_resolution=Lower(Trim('resolution')))
        predicate = Q(pk__in=[])
        for value in filters['resolution']:
            kind, setting = value.split(':', 1)
            resolution = (Q(resolution__isnull=True) | Q(library_resolution='')) if setting == 'unknown' else Q(library_resolution=setting.lower())
            predicate |= Q(kind=kind) & resolution
        rows = rows.filter(predicate)
    if filters.get('creator'):
        known = [value for value in filters['creator'] if value != 'unknown']
        predicate = Q(user_id__in=known)
        if 'unknown' in filters['creator']:
            predicate |= Q(user_id__isnull=True)
        rows = rows.filter(predicate)
    if filters.get('durationBucket'):
        predicates = {'short': Q(duration__gt=0, duration__lte=5),
                      'medium': Q(duration__gte=6, duration__lte=10), 'long': Q(duration__gt=10),
                      'unknown': Q(duration__isnull=True)}
        predicate = Q(pk__in=[])
        for value in filters['durationBucket']:
            predicate |= predicates[value]
        rows = rows.filter(Q(kind='video') & predicate)
    if filters.get('stage'):
        predicate = Q(pk__in=[])
        for value in filters['stage']:
            predicate |= Q(draft_mode={'draft': True, 'final': False, 'unknown': None}[value])
        rows = rows.filter(Q(kind='video') & predicate)
    if filters.get('status'):
        statuses = {'ready': ['succeeded'], 'creating': ['queued', 'running'], 'failed': ['failed']}
        rows = rows.filter(status__in=[status for value in filters['status'] for status in statuses[value]])
    if filters.get('bitrate'):
        rows = rows.alias(library_bitrate=Lower(Trim('bitrate_mode')))
        predicate = Q(pk__in=[])
        for value in filters['bitrate']:
            predicate |= (Q(bitrate_mode__isnull=True) | Q(library_bitrate='')) if value == 'unknown' else Q(library_bitrate=value)
        rows = rows.filter(Q(kind='video') & predicate)
    if 'createdFrom' in filters:
        rows = rows.filter(created_at__gte=filters['createdFrom'])
    if 'createdBefore' in filters:
        rows = rows.filter(created_at__lt=filters['createdBefore'])
    return rows


def library_options(rows):
    rows = rows.order_by()
    models = {}
    for value, kind in rows.values_list('model', 'kind').distinct():
        definition = model_definition(value)
        key = canonical_model(value)
        models[key] = {'value': key, 'label': definition['name'] if definition else value,
                       'kind': kind, 'upscale': bool(definition and definition.get('capabilities', {}).get('upscaleMedia'))}
    resolutions = {f'{kind}:{value.strip().lower() if value and value.strip() else "unknown"}'
                   for kind, value in rows.values_list('kind', 'resolution').distinct()}
    return {'types': sorted(rows.values_list('kind', flat=True).distinct()),
            'models': sorted(models.values(), key=lambda item: item['label'].lower()),
            'resolutions': sorted(resolutions),
            'aspects': sorted(rows.values_list('aspect_ratio', flat=True).distinct()),
            'creators': sorted(str(value) if value else 'unknown'
                               for value in rows.values_list('user_id', flat=True).distinct())}


def query_fingerprint(params, filters):
    source = {key: params.get(key) for key in ('projectId', 'folderId', 'kind', 'q', 'favorite')}
    return hashlib.sha256(json.dumps([source, filters], sort_keys=True).encode()).hexdigest()[:24]


def decode_library_cursor(raw, fingerprint):
    try:
        if len(raw) > 1024 or not raw.startswith('v1:'):
            raise ValueError()
        encoded = raw[3:]
        value = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        if value['query'] != fingerprint or type(value['sort']) is not int or abs(value['sort']) > 8640000000000000 or not isinstance(value['id'], str):
            raise ValueError()
        UUID(value['id'])
        return value
    except (ValueError, KeyError, TypeError) as exc:
        raise ValidationError({'error': 'This cursor belongs to a different or invalid library query.'}) from exc


def encode_library_cursor(sort, identifier, fingerprint):
    value = {'sort': sort, 'id': str(identifier), 'query': fingerprint}
    return 'v1:' + base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
