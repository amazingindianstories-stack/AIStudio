"""Tool errors: ``isError: true`` results shaped ``{code, message, next?}``, each message saying what to do next.

``quote_required``, ``running``, ``failed`` and ``cancelled`` are outcomes, not errors.
"""
from apps.mcp_auth.controls import ControlRefusal

INVALID_INPUT = 'INVALID_INPUT'
MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE'
NOT_FOUND = 'NOT_FOUND'
BUDGET_EXCEEDED = 'BUDGET_EXCEEDED'
RATE_LIMITED = 'RATE_LIMITED'
CONCURRENCY_LIMIT = 'CONCURRENCY_LIMIT'
PAID_BUDGET_HOLD = 'PAID_BUDGET_HOLD'
MAINTENANCE = 'MAINTENANCE'
MCP_DISABLED = 'MCP_DISABLED'
IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT'
VERSION_CONFLICT = 'VERSION_CONFLICT'
INSUFFICIENT_SCOPE = 'INSUFFICIENT_SCOPE'
FORBIDDEN = 'FORBIDDEN'
INTERNAL_ERROR = 'INTERNAL_ERROR'

MAINTENANCE_MESSAGE = 'Veevee is being updated; reading works, creating is paused for a few minutes.'
SWITCHED_OFF_MESSAGE = 'Agent changes are switched off in Veevee right now; reading still works. Ask a Veevee admin.'


class ToolError(Exception):
    def __init__(self, code, message, *, next=None, retry_after_seconds=None):
        super().__init__(message)
        self.code, self.message, self.next, self.retry_after_seconds = code, message, next, retry_after_seconds

    def payload(self):
        body = {'code': self.code, 'message': self.message}
        if self.next:
            body['next'] = self.next
        if self.retry_after_seconds is not None:
            body['retryAfterSeconds'] = self.retry_after_seconds
        return body


def from_refusal(refusal: ControlRefusal):
    """Budget, rate and concurrency refusals from ``apps.mcp_auth.controls``; ``get_account`` shows the limits."""
    if refusal.code != BUDGET_EXCEEDED:
        return ToolError(refusal.code, refusal.message, retry_after_seconds=refusal.retry_after_seconds)
    following = {'tool': 'get_account', 'arguments': {}, 'why': 'Shows your spending today and your limits.'}
    return ToolError(refusal.code, refusal.message + ' get_account shows what you have spent and your limits.', next=following,
                     retry_after_seconds=refusal.retry_after_seconds)


def scope_missing(scope):
    return ToolError(INSUFFICIENT_SCOPE, f'This tool needs the {scope} scope. Create a token with it in Veevee Settings, Agent access.')
