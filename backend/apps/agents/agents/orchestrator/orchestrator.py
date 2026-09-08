"""Port of src/lib/agents/orchestrator/orchestrator.js — the agentic
tool-calling loop: call Gemini with `tools`, and when it returns a
functionCall part, dispatch it locally and feed the result back as a
functionResponse part, repeating until a final text reply arrives.
"""

from .. import llm_provider
from .prompts import system_prompt_for_kind
from .tools import dispatch_tool, tools_for_kind

MAX_TOOL_ROUNDS = 4


def _history_to_contents(history: list[dict]) -> list[dict]:
    return [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
        for m in history if m["role"] != "system"
    ]


def run_orchestrator_turn(history: list[dict], new_message: str, images: list[dict] | None = None, kind: str = "image") -> dict:
    """Returns {"reply": str, "toolTrace": {...} | None}."""
    images = images or []
    contents = _history_to_contents(history)
    contents.append({"role": "user", "parts": [{"text": new_message}, *images]})

    last_trace = None

    for _round in range(MAX_TOOL_ROUNDS):
        result = llm_provider.call_gemini_raw(
            system_prompt_for_kind(kind), contents, tools=tools_for_kind(kind)
        )
        parts = result["parts"]

        function_call_part = next((p for p in parts if p.get("functionCall")), None)
        if function_call_part:
            name = function_call_part["functionCall"]["name"]
            args = function_call_part["functionCall"].get("args") or {}
            # Echo the part back VERBATIM (including any sibling
            # thoughtSignature field) — Gemini 400s the next round if it's
            # dropped on a thinking-enabled model.
            contents.append({"role": "model", "parts": [function_call_part]})

            try:
                dispatched = dispatch_tool(name, args, images)
                response = dispatched["response"]
                last_trace = dispatched["trace"]
            except Exception as e:
                response = {"error": str(e) or "Tool failed."}
            contents.append({"role": "user", "parts": [{"functionResponse": {"name": name, "response": response}}]})
            continue

        text_part = next((p for p in parts if isinstance(p.get("text"), str)), None)
        if text_part and text_part.get("text"):
            return {"reply": text_part["text"], "toolTrace": last_trace}

        raise RuntimeError(f"Orchestrator returned nothing usable ({result.get('finishReason') or 'no candidates'}).")

    raise RuntimeError("Orchestrator exceeded the tool-call round limit without a final reply.")
