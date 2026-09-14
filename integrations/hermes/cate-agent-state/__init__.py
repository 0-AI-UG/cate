"""Hermes lifecycle bridge for Cate terminal session restoration."""

from __future__ import annotations

import json
import os
import re
from typing import Any, Callable
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

PLUGIN_ID = "cate-agent-state"
PLUGIN_VERSION = "1.0.0"
_INTERACTIVE_PLATFORMS = frozenset({"cli", "tui"})
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_HOOKS = (
    "on_session_start",
    "on_session_reset",
    "pre_llm_call",
    "on_session_end",
    "on_session_finalize",
)


class _RejectRedirects(HTTPRedirectHandler):
    """Never forward Cate's terminal bearer token to a redirected endpoint."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Ignore ambient HTTP(S)_PROXY settings: this transport is loopback-only.
_OPENER = build_opener(ProxyHandler({}), _RejectRedirects())


def _cate_connection() -> tuple[str, str, str] | None:
    endpoint = os.environ.get("CATE_HOOK_ENDPOINT", "")
    token = os.environ.get("CATE_HOOK_TOKEN", "")
    terminal_id = os.environ.get("CATE_TERMINAL_ID", "")
    if not endpoint or not token or not terminal_id:
        return None
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return None
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}:
        return None
    return endpoint, token, terminal_id


def _report(hook_event_name: str, profile: str, **kwargs: Any) -> None:
    connection = _cate_connection()
    if connection is None:
        return
    if profile == "custom" or not _PROFILE_RE.fullmatch(profile):
        return
    platform = str(kwargs.get("platform") or "")
    if platform and platform not in _INTERACTIVE_PLATFORMS:
        return
    endpoint, token, terminal_id = connection
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = ""
    body = {
        "agentId": "hermes",
        "terminalId": terminal_id,
        "pid": os.getpid(),
        "payload": {
            "hook_event_name": hook_event_name,
            "session_id": kwargs.get("session_id"),
            "cwd": cwd,
            "profile": profile,
            "platform": platform,
            "reason": kwargs.get("reason"),
        },
    }
    try:
        request = Request(
            endpoint,
            data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with _OPENER.open(request, timeout=0.75) as response:
            response.read(1)
    except Exception:
        # Hooks must never delay or break the user's Hermes session.
        return


def _callback(name: str, profile: str) -> Callable[..., None]:
    def report(**kwargs: Any) -> None:
        _report(name, profile, **kwargs)

    return report


def register(ctx: Any) -> None:
    profile = str(getattr(ctx, "profile_name", "custom"))
    for hook_name in _HOOKS:
        ctx.register_hook(hook_name, _callback(hook_name, profile))
