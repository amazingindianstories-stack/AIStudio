"""Port of src/lib/agents/llm-provider.js — text-chat LLM call for the
agent layer. Reuses GOOGLE_API_KEY and the same generativelanguage REST
endpoint as providers/gemini.py and providers/omni.py."""

import os

import requests

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-flash-latest"


def agent_model() -> str:
    return os.environ.get("AGENT_LLM_MODEL", DEFAULT_MODEL)


def call_gemini_raw(system_prompt: str, contents: list[dict], tools: list[dict] | None = None, model: str | None = None) -> dict:
    """contents: [{"role": "user"|"model", "parts": [GeminiPart, ...]}, ...].
    Returns {"parts", "finishReason", "usage"}."""
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is not set.")

    body: dict = {"systemInstruction": {"parts": [{"text": system_prompt}]}, "contents": contents}
    if tools:
        body["tools"] = [{"functionDeclarations": tools}]

    res = requests.post(
        f"{API_ROOT}/models/{model or agent_model()}:generateContent",
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        json=body,
        timeout=60,
    )
    if not res.ok:
        raise RuntimeError(f"Agent LLM error ({res.status_code}): {res.text[:400]}")

    data = res.json()
    candidate = (data.get("candidates") or [{}])[0]
    usage_meta = data.get("usageMetadata")
    return {
        "parts": (candidate.get("content") or {}).get("parts") or [],
        "finishReason": candidate.get("finishReason"),
        "usage": (
            {"tokensIn": usage_meta.get("promptTokenCount"), "tokensOut": usage_meta.get("candidatesTokenCount")}
            if usage_meta else None
        ),
    }


def call_llm(system_prompt: str, messages: list[dict], model: str | None = None) -> dict:
    """messages: [{"role": "user"|"assistant"|"system", "content": str}, ...].
    Returns {"text", "usage"}."""
    contents = [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
        for m in messages if m["role"] != "system"
    ]
    result = call_gemini_raw(system_prompt, contents, model=model)
    part = next((p for p in result["parts"] if isinstance(p.get("text"), str)), None)
    if not part:
        raise RuntimeError(f"Agent LLM returned no text ({result.get('finishReason') or 'no candidates'}).")
    return {"text": part["text"], "usage": result.get("usage")}
