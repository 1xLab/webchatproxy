#!/usr/bin/env python3
"""Protocol-level smoke test for the webchatproxy MCP SSE endpoint."""
from __future__ import annotations

import argparse
import asyncio
import os

from mcp import ClientSession
from mcp.client.sse import sse_client


async def run(url: str) -> None:
    headers = None
    token = os.environ.get("WEBCHAT_MCP_TOKEN")
    if token:
        headers = {"Authorization": f"Bearer {token}"}

    async with sse_client(url, headers=headers) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = {tool.name for tool in tools.tools}
            required = {
                "chat_completion",
                "list_models",
                "list_projects",
                "list_conversations",
                "get_conversation",
                "list_memories",
                "list_gpts",
                "chat_with_gpt",
                "list_project_files",
            }
            missing = sorted(required - names)
            if missing:
                raise RuntimeError(f"missing MCP tools: {', '.join(missing)}")

            result = await session.call_tool("list_models", {})
            if result.isError:
                text = " ".join(getattr(item, "text", "") for item in result.content)
                raise RuntimeError(f"list_models failed: {text}")

            print(f"mcp_initialize=ok")
            print(f"mcp_tools={len(names)}")
            print("mcp_list_models=ok")
            print("mcp_write_enabled=" + ("1" if "create_project" in names else "0"))
            print("mcp_destructive_enabled=" + ("1" if "delete_project" in names else "0"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8090/sse")
    args = parser.parse_args()
    asyncio.run(run(args.url))


if __name__ == "__main__":
    main()
