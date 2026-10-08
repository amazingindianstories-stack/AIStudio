"""Current Number(string|null), finite/positive check and five-minute fallback."""
import math
import re

WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
DECIMAL = re.compile(r'^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$')


def number_value(raw):
    text = (raw or '').strip(WHITESPACE)
    parsed = 0.0
    try:
        if re.fullmatch(r'0[xX][0-9a-fA-F]+', text):
            parsed = float(int(text[2:], 16))
        elif re.fullmatch(r'0[bB][01]+', text):
            parsed = float(int(text[2:], 2))
        elif re.fullmatch(r'0[oO][0-7]+', text):
            parsed = float(int(text[2:], 8))
        elif DECIMAL.fullmatch(text):
            parsed = float(text)
        elif text:
            parsed = float('nan')
    except (ValueError, OverflowError):
        parsed = float('nan')
    return parsed


def since_watermark(raw, now):
    parsed = number_value(raw)
    return parsed if math.isfinite(parsed) and parsed > 0 else now - 300000
