#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

import aiohttp
from mcp import types as mcp_types
from mcp.server import Server
from mcp.server.stdio import stdio_server

LOG = logging.getLogger("webchatproxy.mcp.router")
BASE_DIR = Path(__file__).resolve().parent.parent

PROVIDERS = {
    "chatgpt": {"base_url": os.environ.get("CHATGPT_API_URL", "http://127.0.0.1:3210"), "key_file": None},
    "deepseek": {"base_url": os.environ.get("DEEPSEEK_API_URL", "http://127.0.0.1:3220"), "key_file": BASE_DIR / "runtime/deepseek/.api-key"},
    "kimi": {"base_url": os.environ.get("KIMI_API_URL", "http://127.0.0.1:3230"), "key_file": BASE_DIR / "runtime/kimi/.api-key"},
    "antigravity": {"base_url": os.environ.get("ANTIGRAVITY_API_URL", "http://127.0.0.1:3240"), "key_file": BASE_DIR / "runtime/antigravity/.api-key"},
}


def _read_key(path: Path | None) -> str | None:
    if path is None:
        return os.environ.get("WEBCHAT_API_TOKEN") or None
    try:
        value = path.read_text(encoding="utf-8").splitlines()[0].strip()
        return value or None
    except (OSError, IndexError):
        return None


class ProviderClient:
    def __init__(self) -> None:
        self.timeout = aiohttp.ClientTimeout(total=float(os.environ.get("WEBCHAT_ROUTER_MCP_TIMEOUT", "240")))

    def _provider(self, name: str) -> dict[str, Any]:
        key = str(name or "").strip().lower()
        if key not in PROVIDERS:
            raise ValueError(f"unknown provider: {name}; expected one of {', '.join(PROVIDERS)}")
        return PROVIDERS[key]

    async def request(self, provider: str, method: str, path: str, *, body: dict[str, Any] | None = None) -> Any:
        cfg = self._provider(provider)
        headers = {"Accept": "application/json"}
        token = _read_key(cfg["key_file"])
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        url = cfg["base_url"].rstrip("/") + path
        async with aiohttp.ClientSession(timeout=self.timeout) as session:
            async with session.request(method, url, json=body, headers=headers) as response:
                text = await response.text()
                try:
                    payload = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    payload = {"raw": text}
                if response.status >= 400:
                    raise RuntimeError(f"{provider} HTTP {response.status}: {text or response.reason}")
                return payload

    async def providers(self) -> dict[str, Any]:
        return {"providers": list(PROVIDERS.keys()), "fallback": False}

    async def health(self, provider: str) -> dict[str, Any]:
        if provider == "kimi":
            payload = await self.request(provider, "GET", "/v1/models")
            return {"provider": provider, "ok": True, "models_reachable": True, "details": payload}
        payload = await self.request(provider, "GET", "/health")
        return {"provider": provider, "ok": True, "details": payload}

    async def models(self, provider: str) -> dict[str, Any]:
        return {"provider": provider, "models": await self.request(provider, "GET", "/v1/models")}

    async def chat(self, args: dict[str, Any]) -> dict[str, Any]:
        provider = str(args.get("provider") or "").strip().lower()
        self._provider(provider)
        messages = args.get("messages")
        if not isinstance(messages, list):
            message = str(args.get("message") or "")
            if not message:
                raise ValueError("message or messages is required")
            messages = [{"role": "user", "content": message}]
        body: dict[str, Any] = {"messages": messages, "stream": False}
        model = args.get("model")
        if model:
            body["model"] = str(model)
        result = await self.request(provider, "POST", "/v1/chat/completions", body=body)
        content = ""
        if isinstance(result, dict):
            choices = result.get("choices")
            if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                message_obj = choices[0].get("message")
                if isinstance(message_obj, dict):
                    content = str(message_obj.get("content") or "")
            if not content:
                content = str(result.get("content") or "")
        return {"provider": provider, "model": model, "content": content, "response": result}


def create_server(client: ProviderClient) -> Server:
    server = Server("webchatproxy-provider-router")

    @server.list_tools()
    async def list_tools() -> list[mcp_types.Tool]:
        return [
            mcp_types.Tool(name="list_providers", description="List configured AI providers. No implicit fallback is used.", inputSchema={"type": "object", "properties": {}}),
            mcp_types.Tool(name="provider_health", description="Check one explicit provider.", inputSchema={"type": "object", "properties": {"provider": {"type": "string", "enum": list(PROVIDERS)}}, "required": ["provider"]}),
            mcp_types.Tool(name="list_models", description="List models for one explicit provider.", inputSchema={"type": "object", "properties": {"provider": {"type": "string", "enum": list(PROVIDERS)}}, "required": ["provider"]}),
            mcp_types.Tool(name="chat_completion", description="Send a non-streaming chat completion to one explicit provider. Never silently routes to another provider.", inputSchema={"type": "object", "properties": {"provider": {"type": "string", "enum": list(PROVIDERS)}, "model": {"type": "string"}, "message": {"type": "string"}, "messages": {"type": "array", "items": {"type": "object", "properties": {"role": {"type": "string"}, "content": {}}, "required": ["role", "content"]}}}, "required": ["provider"]}),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]):
        try:
            args = arguments or {}
            if name == "list_providers":
                result = await client.providers()
            elif name == "provider_health":
                result = await client.health(str(args.get("provider") or ""))
            elif name == "list_models":
                result = await client.models(str(args.get("provider") or ""))
            elif name == "chat_completion":
                result = await client.chat(args)
            else:
                raise ValueError(f"unknown MCP tool: {name}")
            text = result.get("content", "") if name == "chat_completion" else json.dumps(result, ensure_ascii=False, indent=2)
            return [mcp_types.TextContent(type="text", text=str(text))], result
        except Exception as exc:
            LOG.exception("MCP router tool failed: %s", name)
            return mcp_types.CallToolResult(content=[mcp_types.TextContent(type="text", text=str(exc))], isError=True)

    return server


async def run_stdio(server: Server) -> None:
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options(), raise_exceptions=True)


async def run_sse(server: Server, host: str, port: int, token: str | None) -> None:
    import uvicorn
    from mcp.server.sse import SseServerTransport
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse, Response
    from starlette.routing import Mount, Route

    sse = SseServerTransport("/messages")

    def authorized(headers) -> bool:
        return not token or headers.get("authorization", "") == f"Bearer {token}"

    async def handle_sse(request):
        if not authorized(request.headers):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await server.run(streams[0], streams[1], server.create_initialization_options(), raise_exceptions=True)
        return Response()

    async def health(_request):
        return JSONResponse({"service": "webchatproxy-provider-mcp", "providers": list(PROVIDERS), "fallback": False})

    async def guarded_messages(scope, receive, send):
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        if token and headers.get("authorization", "") != f"Bearer {token}":
            await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
            return
        await sse.handle_post_message(scope, receive, send)

    app = Starlette(routes=[Route("/health", health, methods=["GET"]), Route("/sse", handle_sse, methods=["GET"]), Mount("/messages", app=guarded_messages)])
    LOG.info("Provider-neutral MCP SSE listening on http://%s:%d/sse", host, port)
    await uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", loop="asyncio")).serve()


async def amain(args) -> None:
    server = create_server(ProviderClient())
    if args.transport == "stdio":
        await run_stdio(server)
    else:
        await run_sse(server, args.host, args.port, os.environ.get("WEBCHAT_ROUTER_MCP_TOKEN") or None)


def main() -> None:
    parser = argparse.ArgumentParser(description="Provider-neutral MCP router for webchatproxy")
    parser.add_argument("--transport", choices=("stdio", "sse"), default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8100)
    args = parser.parse_args()
    logging.basicConfig(level=os.environ.get("WEBCHAT_ROUTER_MCP_LOG_LEVEL", "INFO"))
    asyncio.run(amain(args))


if __name__ == "__main__":
    main()
