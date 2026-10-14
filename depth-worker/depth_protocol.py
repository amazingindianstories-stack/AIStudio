"""Pure payload builders for the depth worker's backward-compatible protocol."""

from urllib.parse import urljoin

PROTOCOL_VERSION = 2


def claim_payload(worker_id: str) -> dict:
    return {"workerId": worker_id, "protocolVersion": PROTOCOL_VERSION}


def claimed_payload(job_id: str, claim_id: str | None = None, **values) -> dict:
    payload = {"jobId": job_id, **values}
    if claim_id:
        payload["claimId"] = claim_id
    return payload


def heartbeat_payload(worker_id: str, claim_id: str | None = None, **values) -> dict:
    payload = {"workerId": worker_id, "protocolVersion": PROTOCOL_VERSION, **values}
    payload["currentClaimId"] = claim_id
    return payload


def transfer_url(api_url: str, url: str) -> str:
    """Signed transfer URLs are absolute in production (cloud storage); a local
    stack's storage returns a path on the app itself, which resolves against it."""
    return urljoin(api_url.rstrip("/") + "/", url)
