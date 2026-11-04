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
    if definition.get('provider') == 'omnihuman' and (not row or row['unit'] != 'per_second' or row['unitCostCents'] <= 0):
        raise ValueError('OmniHuman pricing is not configured. Ask an administrator to set the account rate before generating.')
    if not row:
        return 0
    if row['unit'] == 'per_second':
        duration = input.get('duration') or 0
        factors = capability(input['model'], 'resolutionPriceFactors', None) or {'480p': .44, '720p': 1, '1080p': 2.46}
        cents = row['unitCostCents'] * duration * factors.get(input.get('resolution'), 1)
        if truthy(input.get('generateAudio')):
            audio = rows.get(definition.get('audioPricingKey', input['model'] + ' · audio'))
            if audio:
                cents += audio['unitCostCents'] * duration
    else:
        if truthy(input.get('hasReferenceImage')):
            row = rows.get(definition.get('imageToImagePricingKey', input['model'] + ' · image-to-image'), row)
        factor = {'1K': 1, '1080p': 1, '2K': 1.5, '4K': 3}.get(input.get('resolution'), 1) if capability(input['model'], 'imagePriceScalesWithResolution', True) is not False else 1
        # GPT Image 2.5: the job's stored quality, relative to the high-quality base row (no stored quality = high).
        quality = (input.get('submissionInput') or {}).get('quality')
        factor *= (capability(input['model'], 'qualityPriceFactors', None) or {}).get(quality, 1)
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


# OpenAI bills GPT Image 2.5 per token class (developers.openai.com/api/docs/pricing, read 2026-11-04). Text output is
# not billed, and the Images API usage has no cached-input field, so the cached rates never apply to these calls.
OPENAI_TOKEN_RATES = ('text input', 'image input', 'image output')


def openai_token_cost(model, usage, pricing):
    """Cents for one GPT Image 2.5 call: its reported text input, image input and image output tokens, each at its
    per-million rate. The generation worker reads stored prices only, so a rate nobody has saved yet comes from the
    defaults. None when the usage or a rate is unusable; the enqueue estimate then stays."""
    from apps.admin_dashboard.default_pricing import DEFAULT_PRICING
    def count(container, key):
        value = container.get(key) if isinstance(container, dict) else None
        return value if type(value) is int and value >= 0 else None
    if not isinstance(usage, dict):
        return None
    input_total, output_total = count(usage, 'input_tokens'), count(usage, 'output_tokens')
    if input_total is None or output_total is None:
        return None
    details = usage.get('input_tokens_details')
    text_in, image_in = count(details, 'text_tokens'), count(details, 'image_tokens')
    if text_in is None or image_in is None or text_in + image_in != input_total:
        # Without a consistent split, bill all input at the higher image-input rate rather than undercount.
        text_in, image_in = 0, input_total
    image_out = count(usage.get('output_tokens_details'), 'image_tokens')
    if image_out is None or image_out > output_total:
        image_out = output_total
    key = (model_definition(model) or {}).get('pricingKey', model)
    stored = {row['model']: row for row in pricing}
    defaults = {row['model']: row for row in DEFAULT_PRICING}
    rates = []
    for name in OPENAI_TOKEN_RATES:
        row = stored.get(f'{key} · {name}') or defaults.get(f'{key} · {name}')
        if not row or row['unit'] != 'per_million_tokens' or type(row['unitCostCents']) not in (int, float) or row['unitCostCents'] < 0:
            return None
        rates.append(row['unitCostCents'])
    return math.floor((text_in * rates[0] + image_in * rates[1] + image_out * rates[2]) / 1000000 + .5)


def kling_units_to_cents(units):
    if units is None or isinstance(units, str) and not units.strip():
        return None
    value = number(units)
    return math.floor(value * .35 + .5) if math.isfinite(value) and value >= 0 else None
