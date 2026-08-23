#!/usr/bin/env python3
"""Compatibility entrypoint for the ChatGPT provider bridge."""
from pathlib import Path
import runpy

TARGET = Path(__file__).resolve().parents[1] / "providers" / "chatgpt" / "engine" / "web2api_bridge.py"
runpy.run_path(str(TARGET), run_name="__main__")
