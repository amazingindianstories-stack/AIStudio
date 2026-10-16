"""Small explicit ECMAScript coercions required by legacy JSON contracts."""
import math
import re
from apps.generation.watermark import WHITESPACE

UNDEFINED = object()


def truthy(value):
    if value is UNDEFINED or value is None or value is False:
        return False
    if type(value) in (int, float):
        return value != 0 and not math.isnan(value)
    return bool(value) if isinstance(value, str) else True


def string(value):
    if value is UNDEFINED:
        return 'undefined'
    if value is None:
        return 'null'
    if type(value) is bool:
        return 'true' if value else 'false'
    if isinstance(value, list):
        return ','.join('' if v is None or v is UNDEFINED else string(v) for v in value)
    if isinstance(value, dict):
        return '[object Object]'
    if isinstance(value, float):
        if math.isnan(value):
            return 'NaN'
        if math.isinf(value):
            return 'Infinity' if value > 0 else '-Infinity'
        if value.is_integer():
            return str(int(value))
    return str(value)


def number(value=UNDEFINED):
    if value is UNDEFINED or isinstance(value, dict):
        return math.nan
    if value is None:
        return 0
    if type(value) in (int, float, bool):
        return float(value)
    if isinstance(value, list):
        value = string(value)
    if not isinstance(value, str):
        return math.nan
    value = value.strip(WHITESPACE)
    if not value:
        return 0
    if re.fullmatch(r'0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+', value):
        return int(value, 0)
    if not re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]?Infinity', value):
        return math.nan
    return float(value)


def rounded(value):
    value = number(value)
    return math.floor(value + .5) if math.isfinite(value) else value


def utf16_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2
