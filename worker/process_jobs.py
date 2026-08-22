#!/usr/bin/env python3
"""Process pending OpenAI Responses API jobs stored in the repository."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ROOT / "projects"
REQUEST_GLOB = "*/jobs/*/*/request.json"


class JobError(RuntimeError):
    pass


def validate_request_path(path: Path) -> None:
    try:
        rel = path.relative_to(ROOT)
    except ValueError as exc:
        raise JobError(f"job fora do repositório: {path}") from exc

    parts = rel.parts
    if (
        len(parts) != 6
        or parts[0] != "projects"
        or parts[2] != "jobs"
        or parts[5] != "request.json"
    ):
        raise JobError(
            "path inválido; esperado "
            "projects/<project>/jobs/<agent>/<job-id>/request.json"
        )


def load_request(path: Path) -> bytes:
    raw = path.read_bytes()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise JobError(f"JSON inválido em {path}: {exc}") from exc

    if not isinstance(payload, dict):
        raise JobError(f"{path} deve conter um objeto JSON")

    return raw


def call_responses_api(raw_request: bytes) -> bytes:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise JobError("OPENAI_API_KEY não configurada")

    base_url = (
        os.environ.get("OPENAI_BASE_URL", "").strip()
        or "https://api.openai.com/v1"
    ).rstrip("/")
    endpoint = f"{base_url}/responses"
    timeout = float(os.environ.get("OPENAI_TIMEOUT_SECONDS", "300"))

    request = urllib.request.Request(
        endpoint,
        data=raw_request,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "ws-com-ia-openai-bridge/1",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise JobError(f"OpenAI HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise JobError(f"erro de rede ao chamar OpenAI: {exc}") from exc

    try:
        json.loads(body)
    except json.JSONDecodeError as exc:
        raise JobError("OpenAI retornou resposta que não é JSON") from exc

    return body


def process_job(request_path: Path) -> bool:
    request_path = request_path.resolve()
    validate_request_path(request_path)

    response_path = request_path.with_name("response.json")
    if response_path.exists():
        print(f"SKIP {request_path.relative_to(ROOT)}: response.json já existe")
        return False

    raw_request = load_request(request_path)
    raw_response = call_responses_api(raw_request)

    tmp_path = response_path.with_name("response.json.tmp")
    tmp_path.write_bytes(raw_response)
    tmp_path.replace(response_path)

    print(f"DONE {response_path.relative_to(ROOT)}")
    return True


def discover_pending() -> list[Path]:
    if not PROJECTS.exists():
        return []
    return sorted(
        path
        for path in PROJECTS.glob(REQUEST_GLOB)
        if not path.with_name("response.json").exists()
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Processa request.json OpenAI pendentes sem transformar o payload."
    )
    parser.add_argument(
        "requests",
        nargs="*",
        type=Path,
        help="request.json específicos; sem argumentos, processa todos os pendentes.",
    )
    args = parser.parse_args()

    if args.requests:
        jobs = [
            path if path.is_absolute() else ROOT / path
            for path in args.requests
        ]
    else:
        jobs = discover_pending()

    if not jobs:
        print("Nenhum job pendente.")
        return 0

    failures = 0
    for job in jobs:
        try:
            process_job(job)
        except (OSError, ValueError, JobError) as exc:
            failures += 1
            print(f"FAIL {job}: {exc}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
