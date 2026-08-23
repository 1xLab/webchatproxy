#!/usr/bin/env python3
"""Compatibility entrypoint for the ChatGPT MCP adapter."""
from pathlib import Path
import runpy

TARGET = Path(__file__).resolve().parents[1] / "providers" / "chatgpt" / "mcp" / "mcp_proxy.py"
runpy.run_path(str(TARGET), run_name="__main__")
