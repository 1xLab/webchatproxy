#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import os

from mcp import ClientSession
from mcp.client.sse import sse_client


async def run(url: str) -> None:
    headers = None
    token = os.environ.get("WEBCHAT_ROUTER_MCP_TOKEN")
    if token:
        headers = {"Authorization": f"Bearer {token}"}

    async with sse_client(url, headers=headers) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = {tool.name for tool in tools.tools}
            required = {"list_providers", "provider_health", "list_models", "chat_completion"}
            missing = sorted(required - names)
            if missing:
                raise RuntimeError(f"missing MCP router tools: {', '.join(missing)}")
            providers = await session.call_tool("list_providers", {})
            if providers.isError:
                raise RuntimeError("list_providers failed")
            print("mcp_router_initialize=ok")
            print(f"mcp_router_tools={len(names)}")
            print("mcp_router_list_providers=ok")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8100/sse")
    args = parser.parse_args()
    asyncio.run(run(args.url))


if __name__ == "__main__":
    main()
