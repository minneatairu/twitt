"""Vercel Python function entrypoint; shared with the local development server."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Handler

class handler(Handler):
    """Concrete entrypoint recognized by Vercel's Python source analysis."""

    pass
