"""Stored generation cost estimates and provider-reported reconciliation."""
import math
from apps.common.javascript import number, truthy
from apps.generation.model_registry import model_definition, capability
from apps.generation.providers.seedream import seedream_size


def read_pricing():
    from apps.admin_dashboard.queries import price_rows
    return price_rows()


def compute_cost(input, pricing):
    definition = model_definition(input['model']) or {}
    rows = {row['model']: row for row in pricing}
    if definition.get('provider') == 'seedream':
        width, height = input.get('width'), input.get('height')
        if not width or not height:
            width, height = map(int, seedream_size(input.get('resolution', '2K'), input.get('aspectRatio', '1:1')).split('x'))
        def rate(key):
            defaults = {'Seedream 5.0 Pro': 4500, 'Seedream 5.0 Pro · large': 9000, 'Seedream 5.0 Pro · extra reference': 300}
            row = rows.get(key, {'unit': 'per_1000_images', 'unitCostCents': defaults[key]})
            if row['unit'] != 'per_1000_images':
                raise ValueError('Seedream pricing requires per_1000_images rates.')
            return row['unitCostCents']
        amount = rate('Seedream 5.0 Pro · large' if width * height > 2610000 else 'Seedream 5.0 Pro')
        amount += max(0, input.get('referenceCount', 0) - 1) * rate('Seedream 5.0 Pro · extra reference')
        return math.floor(amount / 1000 + .5)
    row = rows.get(definition.get('pricingKey', input['model']))
    if not row:
        return 0
    if row['unit'] == 'per_second':
        duration = input.get('duration') or 0
        cents = row['unitCostCents'] * duration * {'480p': .44, '720p': 1, '1080p': 2.46}.get(input.get('resolution'), 1)
        if truthy(input.get('generateAudio')):
            audio = rows.get(definition.get('audioPricingKey', input['model'] + ' · audio'))
            if audio:
                cents += audio['unitCostCents'] * duration
    else:
        if truthy(input.get('hasReferenceImage')):
            row = rows.get(definition.get('imageToImagePricingKey', input['model'] + ' · image-to-image'), row)
        factor = {'1K': 1, '1080p': 1, '2K': 1.5, '4K': 3}.get(input.get('resolution'), 1) if capability(input['model'], 'imagePriceScalesWithResolution', True) is not False else 1
        cents = row['unitCostCents'] * factor
    return math.floor(cents + .5)


def seedance_token_cost(model, total_tokens, had_video_input, pricing):
    if type(total_tokens) not in (int, float) or not math.isfinite(total_tokens) or total_tokens < 0:
        return None
    definition = model_definition(model) or {}
    key = definition.get('videoInputTokenPricingKey' if had_video_input else 'tokenPricingKey',
        model + (' · per-token (video input)' if had_video_input else ' · per-token'))
    row = next((row for row in pricing if row['model'] == key), None)
    return math.floor(row['unitCostCents'] * total_tokens / 1000000 + .5) if row else None


def kling_units_to_cents(units):
    if units is None or isinstance(units, str) and not units.strip():
        return None
    value = number(units)
    return math.floor(value * .35 + .5) if math.isfinite(value) and value >= 0 else None
