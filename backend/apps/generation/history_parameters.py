"""Current history cursor/limit wire semantics, before query execution."""
import math
import re
from .watermark import number_value, WHITESPACE

UUID_TEXT = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


def decode_cursor(raw):
    if not raw or '.' not in raw:
        return None
    sort, identifier = raw.split('.', 1)
    if not sort:
        return None
    number = number_value(sort)
    if not math.isfinite(number) or not UUID_TEXT.fullmatch(identifier):
        return None
    return {'sort': number, 'id': identifier}


def page_limit(raw):
    # parseInt(..., 10) accepts a signed decimal prefix, including trailing junk.
    match = re.match(r'[+-]?[0-9]+', (raw or '').lstrip(WHITESPACE))
    if not match:
        return 20
    try:
        number = float(match.group())
    except (ValueError, OverflowError):
        return 20
    return int(min(max(number, 1), 100)) if math.isfinite(number) else 20
