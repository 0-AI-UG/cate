from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
from urllib.request import ProxyHandler


PLUGIN_PATH = (
    Path(__file__).resolve().parents[1]
    / "integrations"
    / "hermes"
    / "cate-agent-state"
    / "__init__.py"
)
MANIFEST_PATH = PLUGIN_PATH.with_name("plugin.yaml")


def load_plugin():
    spec = importlib.util.spec_from_file_location("cate_agent_state_test", PLUGIN_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {PLUGIN_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeContext:
    def __init__(self, profile_name: str = "work") -> None:
        self.hooks: dict[str, object] = {}
        self.profile_name = profile_name

    def register_hook(self, name: str, callback) -> None:
        self.hooks[name] = callback


class CateAgentStatePluginTests(unittest.TestCase):
    def test_manifest_declares_provided_hooks(self) -> None:
        manifest = MANIFEST_PATH.read_text(encoding="utf-8")
        self.assertIn("provides_hooks:", manifest)
        self.assertNotIn("\nhooks:", manifest)

    def test_accepts_only_literal_loopback_hook_endpoints(self) -> None:
        plugin = load_plugin()
        base_env = {
            "CATE_HOOK_TOKEN": "secret-token",
            "CATE_TERMINAL_ID": "term-1",
        }

        with patch.dict(
            os.environ,
            {**base_env, "CATE_HOOK_ENDPOINT": "http://localhost:43210"},
            clear=False,
        ):
            self.assertIsNone(plugin._cate_connection())

        with patch.dict(
            os.environ,
            {**base_env, "CATE_HOOK_ENDPOINT": "http://[::1]:43210"},
            clear=False,
        ):
            self.assertIsNotNone(plugin._cate_connection())

    def test_transport_disables_proxies_and_redirects(self) -> None:
        plugin = load_plugin()
        proxy_handlers = [
            handler for handler in plugin._OPENER.handlers
            if isinstance(handler, ProxyHandler)
        ]
        self.assertEqual(proxy_handlers, [])
        redirect_handlers = [
            handler for handler in plugin._OPENER.handlers
            if isinstance(handler, plugin._RejectRedirects)
        ]
        self.assertEqual(len(redirect_handlers), 1)
        self.assertIsNone(
            redirect_handlers[0].redirect_request(
                None, None, 302, "Found", {}, "http://example.com/leak"
            )
        )

    def test_registers_only_root_session_lifecycle_hooks(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()

        plugin.register(ctx)

        self.assertEqual(
            set(ctx.hooks),
            {
                "on_session_start",
                "on_session_reset",
                "pre_llm_call",
                "on_session_end",
                "on_session_finalize",
            },
        )

    def test_posts_authenticated_profile_scoped_payload(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            ctx.hooks["pre_llm_call"](
                session_id="20260911_131500_abcd1234",
                platform="cli",
                model="test-model",
            )

        request = send.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:43210")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        body = json.loads(request.data)
        self.assertEqual(body["agentId"], "hermes")
        self.assertEqual(body["terminalId"], "term-1")
        self.assertEqual(body["pid"], os.getpid())
        self.assertRegex(body["processStartedAt"], r"^[1-9][0-9]*$")
        self.assertEqual(
            body["payload"],
            {
                "hook_event_name": "pre_llm_call",
                "session_id": "20260911_131500_abcd1234",
                "cwd": os.getcwd(),
                "profile": "work",
                "platform": "cli",
                "reason": None,
            },
        )

    def test_is_silent_without_cate_environment(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        env = {
            key: value
            for key, value in os.environ.items()
            if key not in {"CATE_HOOK_ENDPOINT", "CATE_HOOK_TOKEN", "CATE_TERMINAL_ID"}
        }

        with patch.dict(os.environ, env, clear=True), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["on_session_start"](session_id="session-1", platform="cli")

        send.assert_not_called()

    def test_drops_noninteractive_surfaces(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["pre_llm_call"](session_id="child-1", platform="subagent")

        send.assert_not_called()

    def test_drops_custom_profiles_that_cannot_be_resumed_safely(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext(profile_name="custom")
        plugin.register(ctx)

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["pre_llm_call"](session_id="session-1", platform="cli")

        send.assert_not_called()

    def test_rejects_non_loopback_endpoint_and_swallows_transport_failures(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        base_env = {
            "CATE_HOOK_TOKEN": "secret-token",
            "CATE_TERMINAL_ID": "term-1",
        }

        with patch.dict(os.environ, {**base_env, "CATE_HOOK_ENDPOINT": "https://example.com/hook"}, clear=False), \
                patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["on_session_start"](session_id="session-1", platform="cli")
            send.assert_not_called()

        with patch.dict(os.environ, {**base_env, "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210"}, clear=False), \
                patch.object(plugin._OPENER, "open", side_effect=OSError("offline")):
            ctx.hooks["on_session_start"](session_id="session-1", platform="cli")


if __name__ == "__main__":
    unittest.main()
