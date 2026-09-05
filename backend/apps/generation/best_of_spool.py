import base64
from pathlib import Path

BEST_OF_MAX_BY_SIZE = {"1K": 4, "2K": 3, "4K": 2}


def bounded_best_of(configured: str | int | None, image_size: str) -> int:
    try:
        requested = int(configured or 2)
    except (TypeError, ValueError):
        requested = 2
    requested = min(4, max(1, requested))
    return min(requested, BEST_OF_MAX_BY_SIZE.get(image_size, 2))


def generate_and_spool_candidates(count: int, directory: str, generate) -> tuple[list[dict], list[Exception]]:
    candidates = []
    errors = []
    for i in range(count):
        try:
            result = generate(i)
            file = Path(directory) / f"candidate-{i}.bin"
            file.write_bytes(base64.b64decode(result["base64"]))
            candidates.append({"file": file, "mimeType": result["mimeType"]})
        except Exception as error:  # noqa: BLE001 - partial candidate success is intentional
            errors.append(error)
    return candidates, errors


def read_spooled_base64(candidate: dict) -> str:
    return base64.b64encode(candidate["file"].read_bytes()).decode()
