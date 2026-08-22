#!/usr/bin/env python3
"""Loopback-only REST bridge around the pinned ChatGPT-Web2API engine.

webchatproxy keeps its public /v1/* contract in Node. This process owns Chrome/CDP
and exposes only the engine operations needed by that facade. It is not intended
for direct external consumption and must stay bound to loopback.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
from typing import Any

from aiohttp import web

from chatgpt_web2api.breakers import BreakerRegistry
from chatgpt_web2api.cdp_driver import CDPDriver
from chatgpt_web2api.chrome import ChromeProcess
from chatgpt_web2api.config import Config
from chatgpt_web2api.mcp_server import (
    do_chat_completion,
    do_get_conversation,
    do_list_models,
    do_list_project_files,
    do_list_projects,
)
from chatgpt_web2api.tab_registry import TabRegistry

LOG = logging.getLogger("webchatproxy.web2api_bridge")


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
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
        self.driver: CDPDriver | None = None
        self.driver_lock = asyncio.Lock()
        self.mutation_lock = asyncio.Lock()
        self.runner: web.AppRunner | None = None
        self.last_error: str | None = None

        self.app = web.Application(client_max_size=2 * 1024 * 1024)
        self.app.router.add_get("/health", self.health)
        self.app.router.add_get("/v1/models", self.models)
        self.app.router.add_get("/v1/projects", self.projects)
        self.app.router.add_get("/v1/conversations", self.conversations)
        self.app.router.add_get("/v1/conversations/{conversation_id}", self.conversation)
        self.app.router.add_get("/v1/projects/{project_id}/files", self.project_files)
        self.app.router.add_post("/v1/chat/completions", self.chat)

    async def ensure_chrome(self) -> None:
        if self.chrome is None:
            self.chrome = ChromeProcess(self.config, breakers=self.breakers)
        await self.chrome.ensure_running()
        await self.chrome.start_monitor()

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

    async def health(self, _request: web.Request) -> web.Response:
        connected = bool(self.driver is not None and self.driver.is_connected)
        chrome_running = self.cdp_reachable()
        status = "healthy" if connected and chrome_running else "degraded" if chrome_running else "starting"
        return web.json_response(
            {
                "status": status,
                "engine": "chatgpt-web2api",
                "chrome_running": chrome_running,
                "driver_connected": connected,
                "cdp_port": self.config.chrome.cdp_port,
                "profile_dir": self.config.chrome.user_data_dir,
                "last_error": self.last_error,
            }
        )

    async def models(self, _request: web.Request) -> web.Response:
        driver = await self.ensure_driver()
        result = await do_list_models(driver)
        return web.json_response(result)

    async def projects(self, _request: web.Request) -> web.Response:
        driver = await self.ensure_driver()
        result = await do_list_projects(driver)
        return web.json_response(result)

    async def conversations(self, request: web.Request) -> web.Response:
        driver = await self.ensure_driver()
        offset = int_arg(request.query.get("offset"), 0, 0)
        limit = int_arg(request.query.get("limit"), 50, 1, 500)
        project_id = (request.query.get("project_id") or "").strip() or None
        all_items = env_bool_value(request.query.get("all"), False)

        if not project_id:
            items = await driver.get_conversations(offset=offset, limit=limit)
            return web.json_response({"conversations": items, "offset": offset, "limit": limit})

        # ChatGPT-Web2API already normalizes gizmo_id on conversation records.
        # Scan pages until the requested project page is filled or the backend ends.
        matched: list[dict[str, Any]] = []
        scan_offset = 0
        batch = 100
        max_pages = 100 if all_items else 20
        pages = 0
        while pages < max_pages:
            page = await driver.get_conversations(offset=scan_offset, limit=batch)
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
        return web.json_response(
            {
                "project_id": project_id,
                "conversations": sliced,
                "offset": offset,
                "limit": limit,
                "pages_scanned": pages,
            }
        )

    async def conversation(self, request: web.Request) -> web.Response:
        driver = await self.ensure_driver()
        conversation_id = request.match_info["conversation_id"].strip()
        result = await do_get_conversation(
            driver,
            {
                "conversation_id": conversation_id,
                "offset": int_arg(request.query.get("offset"), 0, 0),
                "limit": int_arg(request.query.get("limit"), 500, 1, 500),
            },
        )
        return web.json_response(result)

    async def project_files(self, request: web.Request) -> web.Response:
        driver = await self.ensure_driver()
        project_id = request.match_info["project_id"].strip()
        result = await do_list_project_files(driver, {"project_id": project_id})
        return web.json_response(result)

    async def chat(self, request: web.Request) -> web.Response:
        body = await request.json()
        attachments = body.get("attachments") or []
        if attachments:
            return web.json_response(
                {
                    "error": "message attachments are not supported by the pinned ChatGPT-Web2API engine",
                    "code": "ENGINE_ATTACHMENTS_UNSUPPORTED",
                },
                status=501,
            )
        if body.get("reasoning_effort"):
            return web.json_response(
                {
                    "error": "reasoning_effort is not implemented by the pinned engine",
                    "code": "ENGINE_REASONING_EFFORT_UNSUPPORTED",
                },
                status=501,
            )

        messages = body.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return web.json_response({"error": "messages must be a non-empty array"}, status=400)

        system_parts = [text_content(m.get("content")) for m in messages if m.get("role") == "system"]
        user_messages = [m for m in messages if m.get("role") == "user"]
        if not user_messages:
            return web.json_response({"error": "at least one user message is required"}, status=400)

        conversation_id = body.get("conversation_id") or None
        if conversation_id:
            message = text_content(user_messages[-1].get("content"))
        else:
            transcript: list[str] = []
            for item in messages:
                role = item.get("role")
                if role not in {"user", "assistant"}:
                    continue
                transcript.append(f"[{role.title()}]\n{text_content(item.get('content'))}")
            message = "\n\n".join(transcript)

        model = str(body.get("model") or "auto")
        if model == "chatgpt-web":
            model = "auto"
        args = {
            "message": message,
            "system_prompt": "\n\n".join(p for p in system_parts if p) or None,
            "model": model,
            "conversation_id": conversation_id,
            "project_id": body.get("project_id") or None,
        }

        driver = await self.ensure_driver()
        async with self.mutation_lock:
            result = await do_chat_completion(driver, args, self.config)
        return web.json_response(result)

    async def start(self) -> None:
        await self.ensure_chrome()
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


def env_bool_value(raw: str | None, default: bool) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception as exc:
        message = str(exc)
        lower = message.lower()
        code = "ENGINE_AUTH_REQUIRED" if "access token" in lower or "logged in" in lower or "auth" in lower else "ENGINE_UPSTREAM_ERROR"
        status = 503 if code == "ENGINE_AUTH_REQUIRED" else 502
        LOG.exception("engine request failed: %s %s", request.method, request.path)
        return web.json_response({"error": message, "code": code}, status=status)


async def amain() -> None:
    logging.basicConfig(
        level=getattr(logging, os.environ.get("WEBCHAT_ENGINE_LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    bridge = EngineBridge()
    bridge.app.middlewares.append(error_middleware)
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
