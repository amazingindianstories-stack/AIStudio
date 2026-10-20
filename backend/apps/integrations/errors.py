"""Shared outbound HTTP errors without transport dependencies."""

class ProviderError(RuntimeError):
    def __init__(self, message, *, code='provider_error', status=None, provider_response=None, may_have_submitted=True):
        super().__init__(message)
        self.code, self.status, self.provider_response = code, status, provider_response
        self.may_have_submitted = may_have_submitted
