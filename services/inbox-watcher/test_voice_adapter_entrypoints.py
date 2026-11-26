"""Mocked entrypoint contract evidence: watcher car/browser/delegation + unchanged Hermes Telegram TTS path.

No import of the Hermes runtime or Vox plugin; the two functions below are compiled directly from
read-only source at their current paths. No real TTS, upload, subprocess, network or profile is used.
The Telegram probe intentionally documents the external VOX_VOICE override blocker.
"""
import ast
import asyncio
import contextlib
import json
import os
import sys
import types
import typing
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_assigned_voices import AssignedVoices
from test_inbox_watcher import iw

HERMES = Path('/home/delorenj/.hermes/hermes-agent')
VOX_PLUGIN = Path('/home/delorenj/.hermes/plugins/vox/__init__.py')


def unchanged_method(path, cls, method, namespace):
    tree = ast.parse(path.read_text())
    if cls:
        owner = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls)
        nodes = owner.body
    else:
        nodes = tree.body
    node = next(n for n in nodes if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == method)
    module = ast.Module(body=[node], type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(path), 'exec'), namespace)
    return namespace[method]


class Entrypoints(unittest.TestCase):
    setUp = AssignedVoices.setUp
    config = AssignedVoices.config
    fake_synth = AssignedVoices.fake_synth
    memo = AssignedVoices.memo
    def test_car_browser_and_delegated_watcher_step_speak(self):
        for sender, agent, expected in (("car", "tile-a", "carlin"), ("browser", "tile-b", "brule"),
                                        ("car", "tile-a", "brule")):
            with self.subTest(sender=sender, agent=agent, expected=expected):
                m = self.memo(agent=agent, sender={"ok": True, "host": sender},
                              reply_stamp="2026-11-22T01:00:00Z", reply_text="Mock reply.",
                              received_ts=0, status="active", stage="speak")
                if expected == "brule" and agent == "tile-a":
                    m["followups"] = [{"state": "running", "command_id": "cmd", "target": "tile-b",
                                       "kind": "delegation", "display_name": "Tile B", "title": "fixture"}]
                self.renders.clear()
                self.w.done_stage = Mock()
                self.w.fact_fast = Mock()
                with patch.object(iw.mc_, "mc", return_value=SimpleNamespace(returncode=0, stderr="")) as upload, \
                     patch.object(iw.mc_, "s3_stat", return_value={"size": 200}):
                    self.w.step_speak(m)
                upload.assert_called_once()
                self.assertEqual([v for _, v, _ in self.renders], [expected])
                self.assertEqual(m["voice_lock"]["voice"], expected)
                self.assertEqual(self.w.fact_fast.call_args.args[0], "voiced")

    def test_actual_hermes_telegram_auto_tts_function_and_vox_precedence(self):
        gateway = HERMES / 'gateway/platforms/base_auto_tts.py'
        if not gateway.is_file() or not VOX_PLUGIN.is_file():
            self.skipTest('read-only installed Hermes/Vox sources unavailable on this host')
        # Hermes moved auto-TTS synthesis out of BasePlatformAdapter into base_auto_tts.py; the
        # unchanged module-level functions are extracted the same way as before.
        namespace = {'asyncio': asyncio, 'json': json, 'contextlib': contextlib, 'Path': Path,
                     'Optional': typing.Optional, 'logger': SimpleNamespace(warning=Mock())}
        unchanged_method(gateway, None, '_profile_scope', namespace)
        unchanged_method(gateway, None, '_synthesize', namespace)
        synth = unchanged_method(gateway, None, 'synthesize_auto_tts', namespace)
        build_path = lambda platform: str(self.root / 'tts.ogg')
        fake_tts = types.ModuleType('tools.tts_tool')
        seen = []
        fake_tts.check_tts_requirements = lambda: True
        def fake_speech(**kwargs):
            seen.append(kwargs)
            Path(kwargs['output_path']).write_bytes(b'fixture')
            return json.dumps({'success': True, 'file_path': kwargs['output_path']})
        fake_tts.text_to_speech_tool = fake_speech
        tools = types.ModuleType('tools')
        tools.tts_tool = fake_tts
        adapter = SimpleNamespace(platform='telegram', name='telegram', prepare_tts_text=lambda s: s)
        with patch.dict(sys.modules, {'tools': tools, 'tools.tts_tool': fake_tts}):
            paths, requested = asyncio.run(synth(adapter, 'Fixture response', None, build_path))
        self.assertEqual(paths, [requested])
        self.assertEqual(seen, [{'text': 'Fixture response', 'output_path': requested}])
        self.assertNotIn('voice', seen[0])  # Telegram gateway doesn't forward a Holocene voice lock.
        provider = VOX_PLUGIN
        kwargs = {'os': os, 'Optional': typing.Optional}
        env_voice = unchanged_method(provider, 'VoxTTSProvider', '_env_voice', kwargs)
        resolve = unchanged_method(provider, 'VoxTTSProvider', '_resolve_voice', kwargs)
        instance = SimpleNamespace(_env_voice=env_voice, _resolve_default_voice=lambda: 'rick')
        with patch.dict(os.environ, {'VOX_VOICE': 'legacy-pin'}):
            self.assertEqual(resolve(instance, 'carlin'), 'legacy-pin')
        with patch.dict(os.environ, {'VOX_VOICE': ''}):
            self.assertEqual(resolve(instance, 'carlin'), 'carlin')
    def test_actual_hermes_plugin_dispatch_transfers_two_profile_voices_to_vox(self):
        plugin_path = HERMES / 'tools/tts_tool_plugins.py'
        if not plugin_path.is_file() or not VOX_PLUGIN.is_file():
            self.skipTest('read-only installed Hermes/Vox sources unavailable on this host')
        namespace = {'Any': typing.Any, 'Optional': typing.Optional, 'logger': SimpleNamespace(info=Mock()),
                     '_plugin_route_key': lambda provider, cfg: provider,
                     'DEFAULT_COMMAND_TTS_OUTPUT_FORMAT': 'ogg'}
        kwargs = unchanged_method(plugin_path, '', '_plugin_voice_kwargs', namespace)
        namespace['_plugin_voice_kwargs'] = kwargs
        resolve_ns = {'os': os, 'Optional': typing.Optional}
        env_voice = unchanged_method(VOX_PLUGIN, 'VoxTTSProvider', '_env_voice', resolve_ns)
        resolve = unchanged_method(VOX_PLUGIN, 'VoxTTSProvider', '_resolve_voice', resolve_ns)
        provider = SimpleNamespace(_env_voice=env_voice, _resolve_default_voice=lambda: 'rick')
        observed = []
        def synthesize(text, path, **kw):
            observed.append(resolve(provider, kw.get('voice')))
            return path
        namespace['_lookup_plugin_provider'] = lambda *a, **kw: SimpleNamespace(synthesize=synthesize)
        dispatch = unchanged_method(plugin_path, '', '_dispatch_to_plugin_provider', namespace)
        with patch.dict(os.environ, {'VOX_VOICE': ''}):
            for agent in ('tile-a', 'tile-b'):
                voice = self.desk.voice_choice(agent, 'rick')['voice']
                self.assertEqual(dispatch('fixture', 'mock.ogg', 'vox', {'voice': voice}), 'mock.ogg')
        self.assertEqual(observed, ['carlin', 'brule'])
        with patch.dict(os.environ, {'VOX_VOICE': 'legacy-pin'}):
            dispatch('fixture', 'mock.ogg', 'vox', {'voice': 'carlin'})
        self.assertEqual(observed[-1], 'legacy-pin')


if __name__ == '__main__':
    unittest.main()
