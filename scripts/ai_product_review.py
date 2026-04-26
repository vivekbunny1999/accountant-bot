from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib import error, request


REPO_ROOT = Path(__file__).resolve().parent.parent
PROMPT_PATH = REPO_ROOT / "qa" / "prompts" / "accountant_bot_product_review.md"
QA_ROOT = REPO_ROOT / "ui" / "test-results" / "accountant-qa"
BUNDLE_PATH = QA_ROOT / "qa_bundle.md"
OUTPUT_PATH = QA_ROOT / "ai_review.md"
OPENAI_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5-mini"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_TOKENS = 4000


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _find_screenshot_paths(bundle_text: str, bundle_path: Path) -> list[Path]:
    matches = re.findall(r"\[[^\]]+\]\(([^)]+\.(?:png|jpg|jpeg|webp|gif))\)", bundle_text, flags=re.IGNORECASE)
    seen: set[Path] = set()
    paths: list[Path] = []

    for raw_path in matches:
        resolved = (bundle_path.parent / raw_path).resolve()
        if resolved in seen or not resolved.exists():
            continue
        seen.add(resolved)
        paths.append(resolved)

    return paths


def _image_content_items(image_paths: list[Path]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    total_bytes = 0

    for image_path in image_paths:
        size = image_path.stat().st_size
        if total_bytes + size > MAX_IMAGE_BYTES:
            print(
                f"Skipping remaining screenshots after reaching {MAX_IMAGE_BYTES // (1024 * 1024)} MB image budget.",
                file=sys.stderr,
            )
            break

        mime_type, _ = mimetypes.guess_type(image_path.name)
        if not mime_type:
            continue

        encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
        total_bytes += size

        items.append({"type": "input_text", "text": f"Screenshot reference: {image_path.name}"})
        items.append(
            {
                "type": "input_image",
                "image_url": f"data:{mime_type};base64,{encoded}",
                "detail": "low",
            }
        )

    return items


def _extract_output_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    texts: list[str] = []
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                texts.append(content["text"])

    combined = "\n".join(texts).strip()
    if combined:
        return combined

    raise RuntimeError("OpenAI API returned no review text.")


def _call_openai(api_key: str, model: str, prompt_text: str, bundle_text: str, image_paths: list[Path]) -> str:
    content: list[dict[str, Any]] = [
        {
            "type": "input_text",
            "text": (
                "Review the QA bundle and referenced screenshots. "
                "Return markdown only and follow the prompt exactly."
            ),
        },
        {"type": "input_text", "text": f"QA bundle:\n\n{bundle_text}"},
    ]
    content.extend(_image_content_items(image_paths))

    body = {
        "model": model,
        "instructions": prompt_text,
        "input": [
            {
                "role": "user",
                "content": content,
            }
        ],
        "max_output_tokens": MAX_OUTPUT_TOKENS,
    }

    req = request.Request(
        OPENAI_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = None
        message = payload.get("error", {}).get("message") if isinstance(payload, dict) else raw
        raise RuntimeError(f"OpenAI API request failed with HTTP {exc.code}: {message}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"OpenAI API request failed: {exc.reason}") from exc

    return _extract_output_text(payload)


def main() -> int:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("OPENAI_API_KEY is not set. Skipping AI product review.")
        return 0

    if not BUNDLE_PATH.exists():
        print(f"QA bundle not found at {BUNDLE_PATH}. Skipping AI product review.")
        return 0

    if not PROMPT_PATH.exists():
        raise FileNotFoundError(f"Reviewer prompt not found at {PROMPT_PATH}.")

    model = os.getenv("AI_REVIEW_MODEL", "").strip() or DEFAULT_MODEL
    prompt_text = _read_text(PROMPT_PATH)
    bundle_text = _read_text(BUNDLE_PATH)
    image_paths = _find_screenshot_paths(bundle_text, BUNDLE_PATH)

    print(f"Running AI product review with model '{model}'.")
    if image_paths:
        print(f"Attaching {len(image_paths)} screenshot(s) referenced by the QA bundle.")
    else:
        print("No screenshot files were found from bundle links. Proceeding with bundle text only.")

    review_text = _call_openai(api_key, model, prompt_text, bundle_text, image_paths)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(review_text.rstrip() + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"AI product review failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
