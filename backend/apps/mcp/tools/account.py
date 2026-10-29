"""get_account: who the agent acts as, its spending in the trailing day and its limits."""
from apps.mcp_auth import controls
from apps.mcp_auth.models import McpToken

from ..registry import ToolResult, obj, register
from ..runtime import db
from ..shapes import dollars, iso

INTEGER = {'type': 'integer'}
OUTPUT = obj({
    'user': obj({'id': {'type': 'string'}, 'name': {'type': 'string'}, 'role': {'type': 'string'}}, ('id', 'name', 'role')),
    'token': obj({'name': {'type': 'string'}, 'kind': {'enum': ['pat', 'oauth']}, 'client': {'type': 'string'},
                  'scopes': {'type': 'array', 'items': {'type': 'string'}}, 'expiresAt': {'type': 'string'}},
                 ('name', 'kind', 'client', 'scopes', 'expiresAt')),
    'spend': obj({'todayCents': INTEGER, 'dailyCapCents': INTEGER, 'tokenTodayCents': INTEGER, 'tokenCapCents': INTEGER},
                 ('todayCents', 'dailyCapCents', 'tokenTodayCents', 'tokenCapCents')),
    'autoApproveCents': INTEGER, 'confirmAboveCents': INTEGER, 'activeJobs': INTEGER, 'maxActiveJobs': INTEGER,
}, ('user', 'token', 'spend', 'autoApproveCents', 'confirmAboveCents', 'activeJobs', 'maxActiveJobs'))


def account(principal):
    user, caps = principal.user, principal.caps
    row = McpToken.objects.filter(pk=principal.token_row_id).values('name', 'expires_at').first() or {}
    return {
        'user': {'id': str(user.id), 'name': user.name or user.email, 'role': user.role},
        'token': {'name': row.get('name') or principal.client_name, 'kind': principal.kind, 'client': principal.client_name,
                  'scopes': sorted(principal.scopes), 'expiresAt': iso(row.get('expires_at'))},
        'spend': {'todayCents': controls.spent_cents(user.id), 'dailyCapCents': caps.user_daily_cap_cents,
                  'tokenTodayCents': controls.spent_cents(user.id, token_id=principal.token_id),
                  'tokenCapCents': caps.token_daily_cap_cents},
        'autoApproveCents': caps.auto_approve_cents, 'confirmAboveCents': caps.confirm_at_cents,
        'activeJobs': controls.active_jobs(user.id), 'maxActiveJobs': caps.active_jobs,
    }


@register(
    name='get_account', title='Account and limits', scope='veevee.read', read_only=True,
    description=('Show who you are connected as, your spending today, your limits and the auto-approve amount.\n'
                 'Spending is the sum of cost.bookedCents over agent-created jobs from the last 24 hours, in cents: '
                 'every status except jobs cancelled before submission (a cancelled job whose billing is unconfirmed '
                 'counts), a running Seedance 2.5 job at its token estimate. Jobs at or below autoApproveCents run '
                 'without a quote; jobs at or above confirmAboveCents need the user\'s approval first.'),
    input_schema=obj({}), output_schema=OUTPUT)
async def get_account(call):
    result = await db(account, call.principal)
    spend = result['spend']
    return ToolResult(result, f"Connected as {result['user']['name']}; agent spending {dollars(spend['todayCents'])} of "
                              f"{dollars(spend['dailyCapCents'])} in the last 24 hours.")
