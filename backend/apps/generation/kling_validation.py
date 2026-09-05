"""Bounded Kling capability validation that cannot create a provider task."""

import base64
from concurrent.futures import ThreadPoolExecutor
import io
import os
import re

import requests
from PIL import Image

from .providers.kling import KLING_MODELS

TIMEOUT_SECONDS = 20
DEFAULT_HOST = "https://api-singapore.klingai.com"


def _message(result):
    return str((result.get("json") or {}).get("message") or "")


def _rejected_without_task(result):
    payload = result.get("json") or {}
    data = payload.get("data") or {}
    return result.get("status", 0) >= 400 and payload.get("code") != 0 and not (
        data.get("task_id") or data.get("taskId")
    )


def _task_ids(result):
    payload = result.get("json") or {}
    if result.get("status") != 200 or payload.get("code") != 0 or not isinstance(payload.get("data"), (dict, list)):
        return None
    found = set()

    def visit(value):
        if isinstance(value, dict):
            for key in ("task_id", "taskId"):
                if isinstance(value.get(key), str):
                    found.add(value[key])
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload["data"])
    return sorted(found)


def classify_seed_validation(baseline, valid_seed, invalid_seed):
    base, valid, invalid = map(_message, (baseline, valid_seed, invalid_seed))
    if re.search(r"unknown|unexpected|not support", invalid, re.I) and re.search(r"seed", invalid, re.I):
        return "unsupported"
    if re.search(r"seed", invalid, re.I) and invalid != base:
        return "supported"
    if valid == base and invalid == base:
        return "inconclusive"
    return "inconclusive"


def run_kling_validation(call=None):
    api_key = os.environ.get("KLING_API")
    if not api_key:
        return {"configured": False}
    host = os.environ.get("KLING_API_HOST", DEFAULT_HOST).rstrip("/")
    if not host.startswith("https://"):
        raise ValueError("Kling host is not a secure URL")

    if call is None:
        def call(path, method="GET", body=None):
            response = requests.request(
                method, host + path, json=body,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                timeout=TIMEOUT_SECONDS,
            )
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            return {"status": response.status_code, "json": payload}

    before = call("/v1/images/generations?pageNum=1&pageSize=20")
    if before.get("status") != 200 or (before.get("json") or {}).get("code") != 0:
        return {"configured": True, "authenticated": False, "noTaskCreated": True}

    image = Image.new("RGB", (512, 512), "#c82828")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    reference = base64.b64encode(buffer.getvalue()).decode()
    case_specs = []
    for spec in KLING_MODELS:
        for resolution in ("1k", "2k"):
            for mode in ("t2i", "i2i"):
                entry = {"model": spec["modelName"], "resolution": resolution, "mode": mode}
                body = {
                    "prompt": "validation-only", "n": 99,
                    "model_name": spec["modelName"], "resolution": resolution, "aspect_ratio": "1:1",
                }
                if mode == "i2i":
                    body["image"] = reference
                case_specs.append((entry, body))

    model = KLING_MODELS[0]["modelName"]
    seed_specs = [
        {"model_name": model},
        {"model_name": model, "seed": 12345},
        {"model_name": model, "seed": "not-a-number"},
    ]
    payloads = [body for _entry, body in case_specs] + [
        {"prompt": "validation-only", "n": 99, **extra} for extra in seed_specs
    ]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda body: call("/v1/images/generations", "POST", body), payloads))
    cases = list(zip((entry for entry, _body in case_specs), results[:len(case_specs)]))
    baseline, valid_seed, invalid_seed = results[len(case_specs):]
    after = call("/v1/images/generations?pageNum=1&pageSize=20")
    matrix = {}
    for entry, result in cases:
        message = _message(result)
        matrix[f'{entry["model"]}:{entry["resolution"]}:{entry["mode"]}'] = {
            "resolutionRejected": bool(re.search("resolution", message, re.I)),
            "modelRejected": bool(re.search("model", message, re.I)),
            "validationReachedN": bool(re.search(r"\bn\b", message, re.I)),
            "rejectedWithoutTask": _rejected_without_task(result),
        }
    request_safety = all(_rejected_without_task(result) for result in results)
    task_list_stable = _task_ids(before) is not None and _task_ids(before) == _task_ids(after)
    return {
        "configured": True, "authenticated": True, "requestSafetyPass": request_safety,
        "taskListStable": task_list_stable, "noTaskCreated": request_safety and task_list_stable,
        "matrix": matrix, "seedVerdict": classify_seed_validation(baseline, valid_seed, invalid_seed),
    }


def summarize_matrix(matrix):
    routing_total = len(KLING_MODELS)
    routing_passed = 0
    resolution_total = resolution_passed = 0
    routing_failures = []
    resolution_failures = []
    for spec in KLING_MODELS:
        model = spec["modelName"]
        routing_ok = True
        for resolution in ("1k", "2k"):
            for mode in ("t2i", "i2i"):
                key = f"{model}:{resolution}:{mode}"
                entry = matrix.get(key) or {}
                expected_rejection = model == "kling-v2-1" and resolution == "2k" and mode == "i2i"
                passed = (
                    entry.get("resolutionRejected") and entry.get("rejectedWithoutTask")
                    if expected_rejection else
                    not entry.get("resolutionRejected") and not entry.get("modelRejected")
                    and entry.get("validationReachedN") and entry.get("rejectedWithoutTask")
                )
                resolution_total += 1
                resolution_passed += int(bool(passed))
                if not passed:
                    resolution_failures.append(key)
                if resolution == "1k" and not passed:
                    routing_ok = False
                    routing_failures.append(key)
        routing_passed += int(routing_ok)
    return {
        "routingPassed": routing_passed, "routingTotal": routing_total,
        "resolutionPassed": resolution_passed, "resolutionTotal": resolution_total,
        "routingFailures": routing_failures, "resolutionFailures": resolution_failures,
    }
