#!/usr/bin/env python3
"""MCP adapter for webchatproxy.

This process does NOT own Chrome/CDP. It exposes the pinned upstream MCP tool
catalog and forwards tool execution to webchatproxy's loopback Web2API bridge.
That keeps a single browser owner and ensures MCP chat results use the same
canonical conversation-tree reconciliation as the REST API.

The adapter adds a second, protocol-facing reconciliation guard for chat calls:
a bridge response is accepted only when the canonical conversation contains the
exact user message just sent followed by a newer assistant message. This prevents
a backend propagation race from returning the previous assistant turn.

Transports:
  stdio (default)  - local MCP clients
  sse              - remote/web MCP clients, loopback by default
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any
from urllib.parse import quote

import aiohttp
from mcp import types as mcp_types
from mcp.server import Server
from mcp.server.stdio import stdio_server
from chatgpt_web2api.mcp_server import ToolName, build_tools

LOG = logging.getLogger("webchatproxy.mcp")
WRITE_ENV = "W2A_ENABLE_WRITE"
DESTRUCTIVE_ENV = "W2A_ENABLE_DESTRUCTIVE"
WRITE_TOOLS = {
    ToolName.CREATE_PROJECT.value,
    ToolName.UPDATE_PROJECT_INSTRUCTIONS.value,
    ToolName.CREATE_MEMORY.value,
    ToolName.ARCHIVE_CONVERSATION.value,
}
DESTRUCTIVE_TOOLS = {
    ToolName.DELETE_CONVERSATION.value,
    ToolName.DELETE_MEMORY.value,
    ToolName.DELETE_PROJECT.value,
}


def enabled(name: str) -> bool:
    return os.environ.get(name) == "1"


def require_tool_gate(name: str) -> None:
    if name in WRITE_TOOLS and not enabled(WRITE_ENV):
        raise PermissionError(f"Tool '{name}' is disabled; set {WRITE_ENV}=1")
    if name in DESTRUCTIVE_TOOLS and not enabled(DESTRUCTIVE_ENV):
        raise PermissionError(f"Tool '{name}' is disabled; set {DESTRUCTIVE_ENV}=1")


def normalized_message_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                value = part.get("text") or part.get("content")
                if value:
                    parts.append(str(value))
        return "\n".join(parts).strip()
    return ""


class BridgeClient:
    def __init__(self) -> None:
        self.base_url = os.environ.get("WEBCHAT_ENGINE_URL", "http://127.0.0.1:3211").rstrip("/")
        self.timeout = aiohttp.ClientTimeout(total=float(os.environ.get("WEBCHAT_MCP_TIMEOUT", "180")))

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        async with aiohttp.ClientSession(timeout=self.timeout) as session:
            async with session.request(method, url, json=json_body, params=params) as response:
                text = await response.text()
                try:
                    payload = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    payload = {"error": text or response.reason}
                if response.status >= 400:
                    message = payload.get("error") if isinstance(payload, dict) else None
                    if isinstance(message, dict):
                        message = message.get("message") or json.dumps(message, ensure_ascii=False)
                    raise RuntimeError(f"bridge HTTP {response.status}: {message or text or response.reason}")
                if not isinstance(payload, dict):
                    raise RuntimeError("bridge returned a non-object JSON response")
                return payload

    async def health(self) -> dict[str, Any]:
        return await self.request("GET", "/health")

    async def reconcile_chat_result(
        self,
        result: dict[str, Any],
        user_message: str,
    ) -> dict[str, Any]:
        """Require the canonical assistant turn that follows this exact user turn.

        The bridge may finish DOM generation before ChatGPT's conversation endpoint
        has propagated the new assistant node. A naive "latest assistant" lookup can
        therefore return the previous turn. Poll the normalized conversation until
        the exact user message sent by this MCP call exists and has an assistant turn
        after it. Never fall back to the potentially stale/corrupted bridge content.
        """
        conversation_id = str(result.get("conversation_id") or "").strip()
        if not conversation_id:
            raise RuntimeError("MCP chat completed without conversation_id")

        attempts = max(1, min(60, int(os.environ.get("WEBCHAT_MCP_RECONCILE_ATTEMPTS", "20"))))
        delay_ms = max(25, min(5000, int(os.environ.get("WEBCHAT_MCP_RECONCILE_DELAY_MS", "250"))))
        encoded = quote(conversation_id, safe="")
        expected = user_message.strip()

        for attempt in range(attempts):
            payload = await self.request(
                "GET",
                f"/v1/conversations/{encoded}",
                params={"offset": 0, "limit": 500},
            )
            conversation = payload.get("conversation") if isinstance(payload, dict) else None
            messages = conversation.get("messages", []) if isinstance(conversation, dict) else []
            if isinstance(messages, list):
                user_index = -1
                for index, message in enumerate(messages):
                    if not isinstance(message, dict):
                        continue
                    if message.get("role") == "user" and normalized_message_text(message) == expected:
                        user_index = index
                if user_index >= 0:
                    for message in messages[user_index + 1 :]:
                        if not isinstance(message, dict) or message.get("role") != "assistant":
                            continue
                        canonical = normalized_message_text(message)
                        if canonical:
                            result["content"] = canonical
                            result["conversation_id"] = conversation_id
                            return result
            if attempt + 1 < attempts:
                await asyncio.sleep(delay_ms / 1000)

        raise RuntimeError(
            "canonical assistant response for the current MCP user turn was not available after generation"
        )

    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        require_tool_gate(name)

        if name == ToolName.CHAT_COMPLETION.value:
            user_message = str(args.get("message") or "")
            messages: list[dict[str, str]] = []
            system_prompt = args.get("system_prompt")
            if system_prompt:
                messages.append({"role": "system", "content": str(system_prompt)})
            messages.append({"role": "user", "content": user_message})
            body = {
                "model": str(args.get("model") or "auto"),
                "messages": messages,
                "conversation_id": args.get("conversation_id") or None,
                "project_id": args.get("project_id") or None,
                "stream": False,
            }
            result = await self.request("POST", "/v1/chat/completions", json_body=body)
            return await self.reconcile_chat_result(result, user_message)

        if name == ToolName.LIST_MODELS.value:
            return await self.request("GET", "/v1/models")
        if name == ToolName.LIST_PROJECTS.value:
            return await self.request("GET", "/v1/projects")
        if name == ToolName.CREATE_PROJECT.value:
            return await self.request("POST", "/v1/projects", json_body=args)
        if name == ToolName.DELETE_PROJECT.value:
            return await self.request("DELETE", f"/v1/projects/{quote(str(args['project_id']), safe='')}")
        if name == ToolName.UPDATE_PROJECT_INSTRUCTIONS.value:
            project_id = quote(str(args["project_id"]), safe="")
            return await self.request(
                "PATCH",
                f"/v1/projects/{project_id}/instructions",
                json_body={"instructions": str(args.get("instructions") or "")},
            )
        if name == ToolName.LIST_PROJECT_FILES.value:
            project_id = quote(str(args["project_id"]), safe="")
            return await self.request("GET", f"/v1/projects/{project_id}/files")

        if name == ToolName.LIST_CONVERSATIONS.value:
            return await self.request(
                "GET",
                "/v1/conversations",
                params={"offset": int(args.get("offset", 0)), "limit": int(args.get("limit", 28))},
            )
        if name == ToolName.GET_CONVERSATION.value:
            conversation_id = quote(str(args["conversation_id"]), safe="")
            return await self.request(
                "GET",
                f"/v1/conversations/{conversation_id}",
                params={"offset": int(args.get("offset", 0)), "limit": int(args.get("limit", 50))},
            )
        if name == ToolName.ARCHIVE_CONVERSATION.value:
            conversation_id = quote(str(args["conversation_id"]), safe="")
            return await self.request(
                "POST",
                f"/v1/conversations/{conversation_id}/archive",
                json_body={"archive": bool(args.get("archive", True))},
            )
        if name == ToolName.DELETE_CONVERSATION.value:
            conversation_id = quote(str(args["conversation_id"]), safe="")
            return await self.request("DELETE", f"/v1/conversations/{conversation_id}")

        if name == ToolName.LIST_MEMORIES.value:
            return await self.request("GET", "/v1/memories")
        if name == ToolName.CREATE_MEMORY.value:
            return await self.request(
                "POST", "/v1/memories", json_body={"content": str(args.get("content") or "")}
            )
        if name == ToolName.DELETE_MEMORY.value:
            memory_id = quote(str(args["memory_id"]), safe="")
            return await self.request("DELETE", f"/v1/memories/{memory_id}")

        if name == ToolName.LIST_GPTS.value:
            return await self.request("GET", "/v1/gpts")
        if name == ToolName.CHAT_WITH_GPT.value:
            user_message = str(args.get("message") or "")
            gpt_id = quote(str(args["gpt_id"]), safe="")
            result = await self.request(
                "POST", f"/v1/gpts/{gpt_id}/chat", json_body={"message": user_message}
            )
            return await self.reconcile_chat_result(result, user_message)

        raise ValueError(f"Unknown MCP tool: {name}")


def create_server(client: BridgeClient) -> Server:
    server = Server("webchatproxy")

    @server.list_tools()
    async def list_tools() -> list[mcp_types.Tool]:
        # Reuse the pinned upstream definitions so schemas, descriptions,
        # annotations and access-gate visibility stay aligned with Web2API.
        return build_tools()

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]):
        try:
            result = await client.call(name, arguments or {})
            if name in {ToolName.CHAT_COMPLETION.value, ToolName.CHAT_WITH_GPT.value}:
                text = str(result.get("content") or "")
            else:
                text = json.dumps(result, ensure_ascii=False, indent=2)
            return [mcp_types.TextContent(type="text", text=text)], result
        except PermissionError as exc:
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(type="text", text=str(exc))], isError=True
            )
        except Exception as exc:
            LOG.exception("MCP tool failed: %s", name)
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(type="text", text=str(exc))], isError=True
            )

    @server.list_resources()
    async def list_resources() -> list[mcp_types.Resource]:
        return [
            mcp_types.Resource(
                uri="chatgpt://models",
                name="Available Models",
                description="ChatGPT model catalog exposed by webchatproxy",
                mimeType="application/json",
            ),
            mcp_types.Resource(
                uri="chatgpt://health",
                name="WebChatProxy Health",
                description="Engine and Chrome/CDP health",
                mimeType="application/json",
            ),
        ]

    @server.read_resource()
    async def read_resource(request: mcp_types.ReadResourceRequest) -> str:
        uri = str(request.params.uri)
        if uri == "chatgpt://models":
            return json.dumps(await client.call(ToolName.LIST_MODELS.value, {}), ensure_ascii=False, indent=2)
        if uri == "chatgpt://health":
            return json.dumps(await client.health(), ensure_ascii=False, indent=2)
        raise ValueError(f"Unknown resource URI: {uri}")

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
        if not token:
            return True
        return headers.get("authorization", "") == f"Bearer {token}"

    async def handle_sse(request):
        if not authorized(request.headers):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await server.run(
                streams[0], streams[1], server.create_initialization_options(), raise_exceptions=True
            )
        return Response()

    async def health(_request):
        try:
            data = await BridgeClient().health()
            return JSONResponse({"service": "webchatproxy-mcp", "bridge": data})
        except Exception as exc:
            return JSONResponse({"service": "webchatproxy-mcp", "error": str(exc)}, status_code=503)

    async def guarded_messages(scope, receive, send):
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        if token and headers.get("authorization", "") != f"Bearer {token}":
            response = JSONResponse({"error": "unauthorized"}, status_code=401)
            await response(scope, receive, send)
            return
        await sse.handle_post_message(scope, receive, send)

    app = Starlette(
        routes=[
            Route("/health", endpoint=health, methods=["GET"]),
            Route("/sse", endpoint=handle_sse, methods=["GET"]),
            Mount("/messages", app=guarded_messages),
        ]
    )
    LOG.info("MCP SSE listening on http://%s:%d/sse", host, port)
    config = uvicorn.Config(app, host=host, port=port, log_level="warning", loop="asyncio")
    await uvicorn.Server(config).serve()


async def amain(args) -> None:
    client = BridgeClient()
    if args.transport == "sse":
        health = await client.health()
        if not health.get("driver_connected"):
            raise RuntimeError("Web2API bridge is not ready/connected")
    server = create_server(client)
    if args.transport == "stdio":
        await run_stdio(server)
    else:
        await run_sse(server, args.host, args.port, os.environ.get("WEBCHAT_MCP_TOKEN") or None)


def main() -> None:
    parser = argparse.ArgumentParser(description="webchatproxy MCP adapter")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio")
    parser.add_argument("--host", default=os.environ.get("WEBCHAT_MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEBCHAT_MCP_PORT", "8090")))
    parser.add_argument("--log-level", default=os.environ.get("WEBCHAT_MCP_LOG_LEVEL", "INFO"))
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
