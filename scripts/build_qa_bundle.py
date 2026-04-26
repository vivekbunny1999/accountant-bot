from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
UI_ROOT = REPO_ROOT / "ui"
QA_ROOT = UI_ROOT / "test-results" / "accountant-qa"
PAGES_ROOT = QA_ROOT / "pages"
RESULTS_PATH = QA_ROOT / "playwright-results.json"
BUNDLE_PATH = QA_ROOT / "qa_bundle.md"


def rel_from_bundle(target: Path) -> str:
    return target.relative_to(QA_ROOT).as_posix()


def format_duration(duration_ms: Any) -> str:
    if duration_ms is None:
        return "n/a"
    try:
        value = float(duration_ms)
    except (TypeError, ValueError):
        return "n/a"
    if value < 1000:
        return f"{int(value)} ms"
    return f"{value / 1000:.1f} s"


def format_location(location: dict[str, Any] | None) -> str:
    if not location or not location.get("url"):
        return "n/a"
    line = location.get("lineNumber")
    column = location.get("columnNumber")
    suffix = ""
    if isinstance(line, int):
        suffix = f":{line + 1}"
        if isinstance(column, int):
            suffix += f":{column + 1}"
    return f"{location['url']}{suffix}"


def escape_fence(text: str) -> str:
    return text.replace("```", "```'`")


def read_json_if_exists(file_path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_page_artifacts(run_started_at: datetime | None = None) -> list[dict[str, Any]]:
    if not PAGES_ROOT.exists():
        return []

    artifacts: list[dict[str, Any]] = []
    for artifact_path in sorted(PAGES_ROOT.glob("*.json")):
        try:
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            artifact = {
                "name": artifact_path.stem,
                "pageUrl": "n/a",
                "pageTitle": "n/a",
                "capturedAt": "n/a",
                "screenshotPath": "",
                "textPath": "",
                "artifactIssues": [f"Artifact JSON could not be parsed: {error}"],
            }

        issues: list[str] = list(artifact.get("artifactIssues") or [])
        text_path = artifact.get("textPath")
        screenshot_path = artifact.get("screenshotPath")
        text_absolute = (UI_ROOT / text_path).resolve() if isinstance(text_path, str) and text_path else None
        screenshot_absolute = (
            (UI_ROOT / screenshot_path).resolve() if isinstance(screenshot_path, str) and screenshot_path else None
        )
        try:
            page_text = text_absolute.read_text(encoding="utf-8") if text_absolute else ""
        except FileNotFoundError:
            page_text = ""

        if not screenshot_absolute or not screenshot_absolute.is_file():
            issues.append("Screenshot file is missing.")
        if not text_absolute or not text_absolute.is_file():
            issues.append("Visible text file is missing.")
        if not (artifact.get("pageUrl") or "").strip():
            issues.append("Captured page URL is missing.")
        if not page_text.strip():
            issues.append("Visible text extraction is empty.")

        captured_at = parse_datetime(artifact.get("capturedAt"))
        if run_started_at and (not captured_at or captured_at < run_started_at):
            issues.append("Artifact does not belong to the current Playwright run.")

        artifact["pageText"] = page_text
        artifact["artifactBundlePath"] = rel_from_bundle(artifact_path.resolve())
        artifact["screenshotBundlePath"] = rel_from_bundle(screenshot_absolute) if screenshot_absolute else "n/a"
        artifact["textBundlePath"] = rel_from_bundle(text_absolute) if text_absolute else "n/a"
        artifact["artifactIssues"] = issues
        artifact["isComplete"] = not issues
        artifacts.append(artifact)

    return sorted(artifacts, key=lambda item: item.get("name", ""))


def flatten_specs(
    suites: list[dict[str, Any]] | None,
    parent_titles: list[str] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    parent_titles = parent_titles or []

    for suite in suites or []:
        titles = [*parent_titles]
        if suite.get("title"):
            titles.append(suite["title"])

        for spec in suite.get("specs", []) or []:
            full_title = " > ".join([*titles, spec.get("title") or "Unnamed spec"])
            for test in spec.get("tests", []) or []:
                results = test.get("results") or []
                last_result = results[-1] if results else {}
                error_message = None
                if isinstance(last_result.get("error"), dict):
                    error_message = last_result["error"].get("message")
                if not error_message:
                    errors = [
                        error.get("message")
                        for error in (last_result.get("errors") or [])
                        if isinstance(error, dict) and error.get("message")
                    ]
                    if errors:
                        error_message = " | ".join(errors)

                rows.append(
                    {
                        "title": full_title,
                        "projectName": test.get("projectName") or "default",
                        "status": last_result.get("status")
                        or test.get("status")
                        or ("passed" if spec.get("ok") and results else None)
                        or test.get("expectedStatus")
                        or "unknown",
                        "duration": last_result.get("duration"),
                        "error": error_message,
                    }
                )

        rows.extend(flatten_specs(suite.get("suites"), titles))

    return rows


def build_bundle() -> None:
    QA_ROOT.mkdir(parents=True, exist_ok=True)

    report = read_json_if_exists(RESULTS_PATH) or {}
    stats = report.get("stats") or {}
    artifacts = load_page_artifacts(parse_datetime(stats.get("startTime")))
    complete_artifacts = [artifact for artifact in artifacts if artifact.get("isComplete")]
    test_rows = flatten_specs(report.get("suites"))

    total_console_errors = sum(len(item.get("consoleErrors") or []) for item in complete_artifacts)
    total_failed_requests = sum(len(item.get("failedNetworkRequests") or []) for item in complete_artifacts)
    invalid_artifact_count = len(artifacts) - len(complete_artifacts)

    validation_errors: list[str] = []
    if not complete_artifacts:
        validation_errors.append("Captured pages = 0. QA capture is invalid because no complete page artifacts exist.")
    if any(row.get("status") == "passed" for row in test_rows) and not complete_artifacts:
        validation_errors.append("Playwright reported passed tests, but this run produced no page artifacts.")
    if invalid_artifact_count:
        validation_errors.append(f"{invalid_artifact_count} page artifact(s) are incomplete, missing files, or stale.")

    lines = [
        "# Accountant Bot QA Bundle",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        f"Base URL: {os.environ.get('E2E_BASE_URL', 'http://127.0.0.1:3000')}",
        "",
        "## Test Results Summary",
        "",
        f"- Expected tests: {stats.get('expected', len(test_rows))}",
        f"- Unexpected tests: {stats.get('unexpected', 0)}",
        f"- Skipped tests: {stats.get('skipped', 0)}",
        f"- Flaky tests: {stats.get('flaky', 0)}",
        f"- Duration: {format_duration(stats.get('duration'))}",
        f"- Captured pages: {len(complete_artifacts)}",
        f"- Invalid or stale artifacts: {invalid_artifact_count}",
        f"- Console errors across captured pages: {total_console_errors}",
        f"- Failed network requests across captured pages: {total_failed_requests}",
        "",
        "## Individual Test Results",
        "",
    ]

    if not test_rows:
        lines.append("- No Playwright JSON results were found.")
    else:
        for row in test_rows:
            display_status = row["status"]
            if display_status == "passed" and not complete_artifacts:
                display_status = "invalid-no-artifacts"
            lines.append(
                f"- [{display_status}] {row['title']} ({row['projectName']}, {format_duration(row.get('duration'))})"
            )
            if row.get("error"):
                lines.append(f"  Error: {row['error']}")

    report_errors = report.get("errors") or []
    if report_errors:
        lines.extend(["", "## Reporter Errors", ""])
        for error in report_errors:
            if isinstance(error, dict) and error.get("message"):
                lines.append(f"- {error['message']}")

    if validation_errors:
        lines.extend(["", "## Validation Errors", ""])
        for error in validation_errors:
            lines.append(f"- {error}")

    lines.extend(["", "## Page Artifacts", ""])

    if not complete_artifacts:
        lines.append("- No page artifacts were found.")
    else:
        for artifact in complete_artifacts:
            lines.extend(
                [
                    f"### {artifact.get('name', 'unnamed')}",
                    "",
                    f"- Captured at: {artifact.get('capturedAt', 'n/a')}",
                    f"- URL: {artifact.get('pageUrl', 'n/a')}",
                    f"- Title: {artifact.get('pageTitle') or 'n/a'}",
                    f"- Artifact record: [{artifact['artifactBundlePath']}]({artifact['artifactBundlePath']})",
                    f"- Screenshot: [{artifact['screenshotBundlePath']}]({artifact['screenshotBundlePath']})",
                    f"- Visible text file: [{artifact['textBundlePath']}]({artifact['textBundlePath']})",
                    f"- Console errors: {len(artifact.get('consoleErrors') or [])}",
                    f"- Failed network requests: {len(artifact.get('failedNetworkRequests') or [])}",
                    "",
                ]
            )

            console_errors = artifact.get("consoleErrors") or []
            if console_errors:
                lines.extend(["#### Console Errors", ""])
                for error in console_errors:
                    lines.append(
                        f"- {error.get('text', 'Unknown console error')} ({format_location(error.get('location'))})"
                    )
                lines.append("")

            failed_requests = artifact.get("failedNetworkRequests") or []
            if failed_requests:
                lines.extend(["#### Failed Network Requests", ""])
                for request in failed_requests:
                    status_suffix = ""
                    if request.get("status"):
                        status_suffix = f" ({request['status']}"
                        if request.get("statusText"):
                            status_suffix += f" {request['statusText']}"
                        status_suffix += ")"
                    lines.append(
                        f"- {request.get('method', 'GET')} {request.get('url', 'n/a')} "
                        f"[{request.get('resourceType', 'unknown')}] -> {request.get('reason', 'Unknown failure')}"
                        f"{status_suffix}"
                    )
                lines.append("")

            lines.extend(
                [
                    "#### Visible Page Text",
                    "",
                    "```text",
                    escape_fence(artifact.get("pageText") or "(empty page text)"),
                    "```",
                    "",
                ]
            )

    if invalid_artifact_count:
        lines.extend(["", "## Incomplete Or Stale Artifacts", ""])
        for artifact in artifacts:
            issues = artifact.get("artifactIssues") or []
            if not issues:
                continue
            lines.append(f"### {artifact.get('name', 'unnamed')}")
            lines.append("")
            lines.append(f"- Artifact record: [{artifact['artifactBundlePath']}]({artifact['artifactBundlePath']})")
            for issue in issues:
                lines.append(f"- {issue}")
            lines.append("")

    BUNDLE_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {BUNDLE_PATH}")
    if validation_errors:
        raise SystemExit("QA bundle validation failed:\n- " + "\n- ".join(validation_errors))


if __name__ == "__main__":
    build_bundle()
