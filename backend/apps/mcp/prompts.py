"""MCP prompts: four plain workflows a user can pick in their client. A prompt is guidance text only; it never calls a
tool or spends money, and every workflow prices its jobs and asks the user before anything paid runs."""
import mcp_types as types
from mcp.shared.exceptions import MCPError

from .resources import caller_principal

INVALID_PARAMS = -32602
COST_RULE = ('Before any paid call, call estimate_cost with the exact arguments, tell me the total, and wait for my '
             'go-ahead. If a call comes back with outcome "quote_required", show me the price and repeat the call with '
             'its quoteToken only after I agree.')


def argument(name, description, required=True):
    return types.PromptArgument(name=name, description=description, required=required)


def storyboard(values):
    model = values.get('model') or 'the video model list_models suggests for shots like these'
    return (f"Turn this storyboard into a shot list and generate it with Veevee.\n\nStoryboard:\n{values['storyboard']}\n\n"
            '1. Call list_models and read each video model\'s inputs and prices.\n'
            '2. Split the storyboard into numbered shots. For each shot write one prompt, an aspect ratio and a '
            f'duration, using {model}.\n'
            f'3. Show me the table of shots. {COST_RULE}\n'
            '4. Start the shots with generate_video and wait=false, then follow each with get_generation {id, wait: true} '
            'until it finishes.\n'
            '5. Report each shot\'s name and id. Store ids, not links; get_download_links gives fresh links later.')


def draft_then_final(values):
    return ("Make a Seedance 2.5 video the cheap way: a draft first, the final only once I approve it.\n\n"
            f"Idea:\n{values['idea']}\n\n"
            '1. Call list_models and check seedance-25 is listed with draft in its inputs.\n'
            f'2. Generate a draft with generate_video {{model: "seedance-25", draft: true, resolution: "480p"}}. {COST_RULE}\n'
            '3. When the draft is ready, show it to me and ask whether to finalize it, change the prompt, or stop.\n'
            '4. Only after I approve, call finalize_draft with the draft id. It is priced and confirmed the same way.\n'
            '5. Give me the final\'s name and id.')


def product_variations(values):
    count = values.get('count') or '4'
    return (f"Make {count} product shot variations with Veevee.\n\nProduct and brief:\n{values['product']}\n\n"
            '1. If I named a reference image in the library, find it with search_generations and use its id in '
            'referenceIds; otherwise ask me for one or work from the text.\n'
            '2. Call list_models and pick an image model that takes references.\n'
            f'3. Write {count} prompts that vary background, lighting and angle while keeping the product identical. '
            f'{COST_RULE}\n'
            '4. Generate them with generate_image, and show me each finished image with its name.')


def upscale_delivery(values):
    target = values.get('target') or 'the delivery size I give you'
    return (f"Prepare finished media for delivery at {target}.\n\nWhat to upscale:\n{values['selection']}\n\n"
            '1. Find the items with search_generations (or use the ids I gave you) and confirm the list with me.\n'
            '2. Call list_models and pick Magnific models: image upscale models for images, video ones for videos.\n'
            f'3. Choose the smallest scale or resolution that reaches the target. {COST_RULE}\n'
            '4. Run upscale_media for each, then give me the names and ids of the upscaled files and, if I ask, '
            'one ZIP with export_zip.')


PROMPTS = {
    'storyboard_to_shots': (types.Prompt(name='storyboard_to_shots', title='Storyboard to shots',
                                         description='Break a storyboard into priced video shots and generate them after you approve the cost.',
                                         arguments=[argument('storyboard', 'The storyboard or script, shot by shot or as prose.'),
                                                    argument('model', 'Optional video model id from list_models.', False)]),
                            storyboard),
    'seedance_draft_then_final': (types.Prompt(name='seedance_draft_then_final', title='Seedance draft, then final',
                                               description='Make a cheap Seedance 2.5 draft first and render the final only once you approve it.',
                                               arguments=[argument('idea', 'What the video should show.')]),
                                  draft_then_final),
    'product_shot_variations': (types.Prompt(name='product_shot_variations', title='Product shot variations',
                                             description='Make several product image variations that keep the product the same.',
                                             arguments=[argument('product', 'The product and the brief.'),
                                                        argument('count', 'How many variations (default 4).', False)]),
                                product_variations),
    'upscale_for_delivery': (types.Prompt(name='upscale_for_delivery', title='Upscale for delivery',
                                          description='Upscale chosen images or videos to a delivery size with Magnific, priced first.',
                                          arguments=[argument('selection', 'Which items: names, ids, a folder or a description.'),
                                                     argument('target', 'Optional target size, e.g. 4K.', False)]),
                             upscale_delivery),
}


async def list_prompts(ctx, params):
    caller_principal(ctx)
    return types.ListPromptsResult(prompts=[prompt for prompt, _ in PROMPTS.values()])


async def get_prompt(ctx, params):
    caller_principal(ctx)
    entry = PROMPTS.get(params.name)
    if entry is None:
        raise MCPError(INVALID_PARAMS, f'Unknown prompt: {params.name}. Call prompts/list for the prompts available.')
    prompt, build = entry
    values = {key: value.strip() for key, value in (params.arguments or {}).items() if isinstance(value, str) and value.strip()}
    missing = [item.name for item in prompt.arguments if item.required and item.name not in values]
    if missing:
        raise MCPError(INVALID_PARAMS, f"The {prompt.name} prompt needs: {', '.join(missing)}.")
    return types.GetPromptResult(description=prompt.description, messages=[
        types.PromptMessage(role='user', content=types.TextContent(type='text', text=build(values)))])
