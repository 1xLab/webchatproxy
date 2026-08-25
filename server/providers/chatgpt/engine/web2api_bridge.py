#!/usr/bin/env python3
"""Loopback-only REST bridge around the pinned ChatGPT-Web2API engine.

The bridge is intentionally thin: business operations delegate to the pinned
upstream do_* functions. Chrome/CDP ownership stays here; the public Node gateway
remains responsible for external auth, jobs and compatibility.

Chat generation has one deliberate hardening layer: the upstream DOM stream can
briefly expose UI-state text such as "Thinking"/"Pensando" and then replace that
node with the real assistant answer. Delta calculation across that replacement
can leak the placeholder and truncate the beginning of the final answer. We use
the DOM stream only to drive/wait for generation, then reconcile the result from
the canonical conversation tree before returning it to callers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
import time
import uuid
from typing import Any

from aiohttp import web

from chatgpt_web2api.breakers import BreakerRegistry
from chatgpt_web2api.cdp_driver import CDPDriver
from chatgpt_web2api.chrome import ChromeProcess
from chatgpt_web2api.completion_detector import DetectorBudgets
from chatgpt_web2api.config import Config
from chatgpt_web2api.mcp_server import (
    do_archive_conversation,
    do_chat_completion,
    do_chat_with_gpt,
    do_create_memory,
    do_create_project,
    do_delete_conversation,
    do_delete_memory,
    do_delete_project,
    do_get_conversation,
    do_list_gpts,
    do_list_memories,
    do_list_models,
    do_list_project_files,
    do_list_projects,
    do_update_project_instructions,
)
from chatgpt_web2api.tab_registry import TabRegistry

LOG = logging.getLogger("webchatproxy.web2api_bridge")
ENGINE_COMMIT = "497527dceabfa3f95961e23c291e618c5570f1ac"
WRITE_ENV = "W2A_ENABLE_WRITE"
DESTRUCTIVE_ENV = "W2A_ENABLE_DESTRUCTIVE"


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_bool_value(raw: str | None, default: bool) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def int_arg(value: Any, default: int, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


async def list_conversations(driver: CDPDriver, offset: int, limit: int) -> list[dict[str, Any]]:
    """Fetch and normalize recent conversations via the pinned CDPDriver API."""
    raw = await driver.get_conversations(offset=offset, limit=limit)
    return [
        {
            "id": item.get("id", ""),
            "title": item.get("title", "Untitled"),
            "update_time": item.get("update_time"),
            "gizmo_id": item.get("gizmo_id"),
        }
        for item in raw
    ]


def text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                value = part.get("text") or part.get("content") or ""
                if value:
                    parts.append(str(value))
        return "\n".join(parts)
    if content is None:
        return ""
    return str(content)


def message_text(message: dict[str, Any] | None) -> str:
    """Extract textual content from a ChatGPT backend conversation message."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content") or {}
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        return ""
    return " ".join(part for part in parts if isinstance(part, str)).strip()


def latest_assistant_from_tree(data: dict[str, Any]) -> str:
    """Walk current_node backwards and return the newest assistant message."""
    mapping = data.get("mapping") or {}
    node_id = data.get("current_node")
    visited: set[str] = set()
    while node_id and node_id not in visited:
        visited.add(node_id)
        node = mapping.get(node_id) or {}
        message = node.get("message")
        if isinstance(message, dict) and (message.get("author") or {}).get("role") == "assistant":
            text = message_text(message)
            if text:
                return text
        node_id = node.get("parent")
    return ""


def require_gate(name: str) -> None:
    if os.environ.get(name) != "1":
        raise web.HTTPForbidden(
            text=json.dumps({"error": f"operation disabled; set {name}=1", "code": "ENGINE_OPERATION_GATED"}),
            content_type="application/json",
        )


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception as exc:
        message = str(exc)
        lower = message.lower()
        code = (
            "ENGINE_AUTH_REQUIRED"
            if "access token" in lower or "logged in" in lower or "auth" in lower
            else "ENGINE_UPSTREAM_ERROR"
        )
        status = 503 if code == "ENGINE_AUTH_REQUIRED" else 502
        LOG.exception("engine request failed: %s %s", request.method, request.path)
        return web.json_response({"error": message, "code": code}, status=status)


class EngineBridge:
    def __init__(self) -> None:
        self.host = os.environ.get("WEBCHAT_ENGINE_HOST", "127.0.0.1")
        self.port = int_arg(os.environ.get("WEBCHAT_ENGINE_PORT"), 3211, 1, 65535)
        if self.host not in {"127.0.0.1", "localhost", "::1"}:
            raise RuntimeError("WEBCHAT_ENGINE_HOST must be loopback")

        self.config = Config.load(None)
        self.config.chrome.user_data_dir = os.environ.get(
            "WEBCHAT_PROFILE_DIR", self.config.chrome.user_data_dir
        )
        self.config.chrome.cdp_port = int_arg(
            os.environ.get("WEBCHAT_ENGINE_CDP_PORT"), self.config.chrome.cdp_port, 1, 65535
        )
        chrome_path = os.environ.get("WEBCHAT_ENGINE_CHROME_PATH") or os.environ.get(
            "REMOTE_IA_BROWSER_EXECUTABLE"
        )
        if chrome_path:
            self.config.chrome.chrome_path = chrome_path
        self.config.chrome.headless = env_bool("WEBCHAT_HEADLESS", False)
        self.config.chatgpt.tab_mode = "owned"
        self.config.chatgpt.parallel_tabs = False
        self.config.server.host = self.host
        self.config.server.port = self.port

        self.breakers = BreakerRegistry()
        self.chrome: ChromeProcess | None = None
        self.chrome_monitor_started = False
        self.driver: CDPDriver | None = None
        self.driver_lock = asyncio.Lock()
        self.mutation_lock = asyncio.Lock()
        self.runner: web.AppRunner | None = None
        self.last_error: str | None = None

        self.app = web.Application(client_max_size=2 * 1024 * 1024, middlewares=[error_middleware])
        self.app.router.add_get("/health", self.health)
        self.app.router.add_get("/v1/models", self.models)
        self.app.router.add_get("/v1/projects", self.projects)
        self.app.router.add_post("/v1/projects", self.create_project)
        self.app.router.add_delete("/v1/projects/{project_id}", self.delete_project)
        self.app.router.add_patch("/v1/projects/{project_id}/instructions", self.update_project_instructions)
        self.app.router.add_get("/v1/projects/{project_id}/files", self.project_files)
        self.app.router.add_get("/v1/conversations", self.conversations)
        self.app.router.add_get("/v1/conversations/{conversation_id}", self.conversation)
        self.app.router.add_post("/v1/conversations/{conversation_id}/archive", self.archive_conversation)
        self.app.router.add_delete("/v1/conversations/{conversation_id}", self.delete_conversation)
        self.app.router.add_get("/v1/memories", self.memories)
        self.app.router.add_post("/v1/memories", self.create_memory)
        self.app.router.add_delete("/v1/memories/{memory_id}", self.delete_memory)
        self.app.router.add_get("/v1/gpts", self.gpts)
        self.app.router.add_post("/v1/gpts/{gpt_id}/chat", self.chat_with_gpt)
        self.app.router.add_post("/v1/chat/completions", self.chat)

    async def ensure_chrome(self) -> None:
        if self.chrome is None:
            self.chrome = ChromeProcess(self.config, breakers=self.breakers)
        await self.chrome.ensure_running()
        if not self.chrome_monitor_started:
            await self.chrome.start_monitor()
            self.chrome_monitor_started = True

    async def ensure_driver(self) -> CDPDriver:
        if self.driver is not None and bool(self.driver.is_connected):
            return self.driver
        async with self.driver_lock:
            if self.driver is not None and bool(self.driver.is_connected):
                return self.driver
            await self.ensure_chrome()
            if self.driver is not None:
                try:
                    await self.driver.close()
                except Exception:
                    pass
            driver = CDPDriver(
                cdp_port=self.config.chrome.cdp_port,
                tab_mode="owned",
                instance_id=TabRegistry.derive_instance_id(
                    cdp_port=self.config.chrome.cdp_port,
                    server_identity=f"webchatproxy:{self.port}",
                ),
                breakers=self.breakers,
                parallel_tabs=False,
            )
            try:
                await driver.connect()
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                try:
                    await driver.close()
                except Exception:
                    pass
                raise
            self.driver = driver
            self.last_error = None
            return driver

    def cdp_reachable(self) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", self.config.chrome.cdp_port), timeout=0.25):
                return True
        except OSError:
            return False

    async def reconcile_assistant(self, driver: CDPDriver, conversation_id: str) -> str:
        """Read the final assistant answer from the canonical conversation tree.

        The backend can lag the DOM by a few hundred milliseconds. Retry briefly
        after generation completion. We intentionally do not fall back to the raw
        DOM delta text: returning a retryable upstream error is safer than serving
        a response known to be potentially corrupted at the placeholder->answer
        transition.
        """
        if not conversation_id:
            raise RuntimeError("generation completed without conversation_id")
        attempts = int_arg(os.environ.get("WEBCHAT_RECONCILE_ATTEMPTS"), 12, 1, 60)
        delay_ms = int_arg(os.environ.get("WEBCHAT_RECONCILE_DELAY_MS"), 250, 25, 5000)
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                data = await driver.get_conversation(conversation_id)
                canonical = latest_assistant_from_tree(data)
                if canonical:
                    return canonical
            except Exception as exc:
                last_error = exc
            if attempt + 1 < attempts:
                await asyncio.sleep(delay_ms / 1000)
        suffix = f": {last_error}" if last_error else ""
        raise RuntimeError(f"canonical assistant response unavailable after generation{suffix}")

    async def health(self, _request: web.Request) -> web.Response:
        connected = bool(self.driver is not None and self.driver.is_connected)
        chrome_running = self.cdp_reachable()
        status = "healthy" if connected and chrome_running else "degraded" if chrome_running else "starting"
        return web.json_response({
            "status": status,
            "engine": "chatgpt-web2api",
            "engine_commit": ENGINE_COMMIT,
            "chrome_running": chrome_running,
            "driver_connected": connected,
            "cdp_port": self.config.chrome.cdp_port,
            "profile_dir": self.config.chrome.user_data_dir,
            "last_error": self.last_error,
            "capabilities": {
                "write_enabled": os.environ.get(WRITE_ENV) == "1",
                "destructive_enabled": os.environ.get(DESTRUCTIVE_ENV) == "1",
                "streaming": True,
                "response_reconciliation": "conversation_tree",
            },
        })

    async def models(self, _request: web.Request) -> web.Response:
        return web.json_response(await do_list_models(await self.ensure_driver()))

    async def projects(self, _request: web.Request) -> web.Response:
        return web.json_response(await do_list_projects(await self.ensure_driver()))

    async def create_project(self, request: web.Request) -> web.Response:
        require_gate(WRITE_ENV)
        body = await request.json()
        async with self.mutation_lock:
            result = await do_create_project(await self.ensure_driver(), body)
        return web.json_response(result, status=201)

    async def delete_project(self, request: web.Request) -> web.Response:
        require_gate(DESTRUCTIVE_ENV)
        async with self.mutation_lock:
            result = await do_delete_project(
                await self.ensure_driver(), {"project_id": request.match_info["project_id"].strip()}
            )
        return web.json_response(result)

    async def update_project_instructions(self, request: web.Request) -> web.Response:
        require_gate(WRITE_ENV)
        body = await request.json()
        async with self.mutation_lock:
            result = await do_update_project_instructions(await self.ensure_driver(), {
                "project_id": request.match_info["project_id"].strip(),
                "instructions": str(body.get("instructions") or ""),
            })
        return web.json_response(result)

    async def project_files(self, request: web.Request) -> web.Response:
        return web.json_response(await do_list_project_files(
            await self.ensure_driver(), {"project_id": request.match_info["project_id"].strip()}
        ))

    async def conversations(self, request: web.Request) -> web.Response:
        driver = await self.ensure_driver()
        offset = int_arg(request.query.get("offset"), 0, 0)
        limit = int_arg(request.query.get("limit"), 50, 1, 500)
        project_id = (request.query.get("project_id") or "").strip() or None
        all_items = env_bool_value(request.query.get("all"), False)
        if not project_id:
            return web.json_response({
                "conversations": await list_conversations(driver, offset, limit),
            })

        matched: list[dict[str, Any]] = []
        scan_offset = 0
        batch = 100
        max_pages = 100 if all_items else 20
        pages = 0
        while pages < max_pages:
            page = await list_conversations(driver, scan_offset, batch)
            pages += 1
            if not page:
                break
            matched.extend(item for item in page if item.get("gizmo_id") == project_id)
            scan_offset += len(page)
            if len(page) < batch:
                break
            if not all_items and len(matched) >= offset + limit:
                break
        sliced = matched[offset:] if all_items else matched[offset : offset + limit]
        return web.json_response({
            "project_id": project_id,
            "conversations": sliced,
            "offset": offset,
            "limit": limit,
            "pages_scanned": pages,
        })

    async def conversation(self, request: web.Request) -> web.Response:
        result = await do_get_conversation(await self.ensure_driver(), {
            "conversation_id": request.match_info["conversation_id"].strip(),
            "offset": int_arg(request.query.get("offset"), 0, 0),
            "limit": int_arg(request.query.get("limit"), 500, 1, 500),
        })
        return web.json_response(result)

    async def archive_conversation(self, request: web.Request) -> web.Response:
        require_gate(WRITE_ENV)
        body = await request.json()
        async with self.mutation_lock:
            result = await do_archive_conversation(await self.ensure_driver(), {
                "conversation_id": request.match_info["conversation_id"].strip(),
                "archive": bool(body.get("archive", True)),
            })
        return web.json_response(result)

    async def delete_conversation(self, request: web.Request) -> web.Response:
        require_gate(DESTRUCTIVE_ENV)
        async with self.mutation_lock:
            result = await do_delete_conversation(await self.ensure_driver(), {
                "conversation_id": request.match_info["conversation_id"].strip(),
            })
        return web.json_response(result)

    async def memories(self, _request: web.Request) -> web.Response:
        return web.json_response(await do_list_memories(await self.ensure_driver()))

    async def create_memory(self, request: web.Request) -> web.Response:
        require_gate(WRITE_ENV)
        body = await request.json()
        async with self.mutation_lock:
            result = await do_create_memory(await self.ensure_driver(), {"content": str(body.get("content") or "")})
        return web.json_response(result, status=201)

    async def delete_memory(self, request: web.Request) -> web.Response:
        require_gate(DESTRUCTIVE_ENV)
        async with self.mutation_lock:
            result = await do_delete_memory(await self.ensure_driver(), {
                "memory_id": request.match_info["memory_id"].strip(),
            })
        return web.json_response(result)

    async def gpts(self, _request: web.Request) -> web.Response:
        return web.json_response(await do_list_gpts(await self.ensure_driver()))

    async def chat_with_gpt(self, request: web.Request) -> web.Response:
        body = await request.json()
        async with self.mutation_lock:
            driver = await self.ensure_driver()
            result = await do_chat_with_gpt(driver, {
                "gpt_id": request.match_info["gpt_id"].strip(),
                "message": str(body.get("message") or ""),
            })
            conv_id = str(result.get("conversation_id") or driver._current_conv_id or "")
            result["content"] = await self.reconcile_assistant(driver, conv_id)
        return web.json_response(result)

    def chat_args(self, body: dict[str, Any]) -> tuple[dict[str, Any], str]:
        messages = body.get("messages") or []
        if not isinstance(messages, list) or not messages:
            raise web.HTTPBadRequest(text=json.dumps({"error": "messages must be a non-empty array"}), content_type="application/json")
        system_parts = [text_content(m.get("content")) for m in messages if m.get("role") == "system"]
        user_messages = [m for m in messages if m.get("role") == "user"]
        if not user_messages:
            raise web.HTTPBadRequest(text=json.dumps({"error": "at least one user message is required"}), content_type="application/json")
        conversation_id = body.get("conversation_id") or None
        if conversation_id:
            message = text_content(user_messages[-1].get("content"))
        else:
            transcript: list[str] = []
            for item in messages:
                role = item.get("role")
                if role in {"user", "assistant"}:
                    transcript.append(f"[{role.title()}]\n{text_content(item.get('content'))}")
            message = "\n\n".join(transcript)
        model = str(body.get("model") or "auto")
        if model == "chatgpt-web":
            model = "auto"
        return ({
            "message": message,
            "system_prompt": "\n\n".join(p for p in system_parts if p) or None,
            "model": model,
            "conversation_id": conversation_id,
            "project_id": body.get("project_id") or None,
        }, message)

    async def chat(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        if body.get("attachments"):
            return web.json_response({
                "error": "message attachments are not supported by the pinned ChatGPT-Web2API engine",
                "code": "ENGINE_ATTACHMENTS_UNSUPPORTED",
            }, status=501)
        if body.get("reasoning_effort"):
            return web.json_response({
                "error": "reasoning_effort is not implemented by the pinned engine",
                "code": "ENGINE_REASONING_EFFORT_UNSUPPORTED",
            }, status=501)
        args, _message = self.chat_args(body)
        if env_bool_value(str(body.get("stream", "false")), False):
            return await self.chat_stream(request, args)
        async with self.mutation_lock:
            driver = await self.ensure_driver()
            try:
                if not args.get("conversation_id"):
                    # The facade is explicit: omitting an id means a new chat.
                    # The upstream MCP helper otherwise auto-continues the tab.
                    driver._current_conv_id = None
                result = await do_chat_completion(driver, args, self.config)
                conv_id = str(result.get("conversation_id") or driver._current_conv_id or "")
                result["conversation_id"] = conv_id
                result["content"] = await self.reconcile_assistant(driver, conv_id)
            except Exception:
                # A failed fresh turn can leave a temporary WEB id in the shared
                # driver. Never let the next request auto-continue that state.
                driver._current_conv_id = None
                raise
        return web.json_response(result)

    async def chat_stream(self, request: web.Request, args: dict[str, Any]) -> web.StreamResponse:
        driver = await self.ensure_driver()
        async with self.mutation_lock:
            try:
                model = str(args.get("model") or "auto")
                project_id = args.get("project_id") or None
                conversation_id = args.get("conversation_id") or None
                system_prompt = args.get("system_prompt") or None
                message = str(args.get("message") or "")
                full_text = f"[System Instructions]\n{system_prompt}\n\n[User]\n{message}" if system_prompt else message
                if model != "auto":
                    await driver.select_model(model)
                if conversation_id:
                    await driver.navigate_conversation(conversation_id)
                else:
                    await driver.navigate_new_chat(gizmo_id=project_id)

                # Important: do not forward raw DOM deltas. ChatGPT can replace a
                # temporary reasoning/status node (e.g. "Pensando") with the final
                # answer, and the upstream delta logic can then leak that placeholder
                # and lose the beginning of the real text. We still consume the
                # stream so generation/completion detection works, but emit only the
                # reconciled canonical response after completion.
                budgets = DetectorBudgets.from_config(self.config.chatgpt, model)
                async for _chunk in driver.send_and_stream(
                    message if not system_prompt else full_text,
                    timeout=120,
                    budgets=budgets,
                    model=model,
                ):
                    pass

                conv_id = str(driver._current_conv_id or conversation_id or "")
                canonical = await self.reconcile_assistant(driver, conv_id)
            except Exception:
                driver._current_conv_id = None
                raise

            response = web.StreamResponse(status=200, headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            })
            await response.prepare(request)
            completion_id = f"chatcmpl-{uuid.uuid4().hex[:29]}"
            created = int(time.time())
            try:
                payload = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": canonical}, "finish_reason": None}],
                }
                await response.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
                final_payload = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "conversation_id": conv_id,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                await response.write(
                    f"data: {json.dumps(final_payload, ensure_ascii=False)}\n\ndata: [DONE]\n\n".encode()
                )
            finally:
                await response.write_eof()
            return response

    async def start(self) -> None:
        await self.ensure_driver()
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        await web.TCPSite(self.runner, self.host, self.port).start()
        LOG.info("ChatGPT-Web2API bridge listening on http://%s:%s", self.host, self.port)

    async def stop(self) -> None:
        if self.runner:
            await self.runner.cleanup()
        if self.driver:
            try:
                await self.driver.close()
            except Exception:
                pass
        if self.chrome:
            try:
                await self.chrome.stop()
            except Exception:
                pass


async def amain() -> None:
    logging.basicConfig(
        level=getattr(logging, os.environ.get("WEBCHAT_ENGINE_LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    bridge = EngineBridge()
    await bridge.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    await stop.wait()
    await bridge.stop()


if __name__ == "__main__":
    asyncio.run(amain())
