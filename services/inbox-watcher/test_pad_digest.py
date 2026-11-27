import http.client
import io
import tempfile
import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pad_digest as p

NOW = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
TOKEN = 'fixture-only-' + 'a' * 40


def digest(agent='alpha-pm', session='sess-1', status='available', text='Implemented work. Verified it.'):
    return dict(agentId=agent, sourceSessionId=session, sourceThreadId='thread-1', sourceEventIds=['src-1'],
                sourceAt=NOW, generatedAt=NOW, asOf=NOW, status=status, text=text)


class Desk:
    def voice_choice(self, agent, emergency, check_catalog) -> dict:
        return dict(effective_voice='owner-voice', source='profile')


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.source = digest()
        self.calls = []
        def fetch(url, secret):
            self.calls.append((url, secret))
            return self.source
        self.consumer = p.Consumer({'fixture-device': TOKEN}, Desk(), lambda text, tmp, voice: b'ogg-data',
                                   fetch=fetch, route=lambda id: {'ok': id in ('alpha-pm', 'beta-pm')})
        self.base = '/v1/pad-digest?agentId=alpha-pm'
        self.auth = 'Bearer ' + TOKEN

    def test_authenticated_http_and_anonymous_denial(self):
        server = p.server(self.consumer, 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f'http://127.0.0.1:{server.server_port}' + self.base
        for header in (None, 'Bearer wrong', 'Bearer invalid-é'):
            with self.assertRaises(urllib.error.HTTPError) as exc:
                urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': header} if header else {}))
            self.assertEqual(exc.exception.code, 401)
            self.assertNotIn('text', json.loads(exc.exception.read()))
            exc.exception.close()
        for path in ('/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId='+'a'*64, '/v1/pad-digest?agentId=alpha-pm&sourceSessionId=sess-1'):
            with self.assertRaises(urllib.error.HTTPError) as denial:
                urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}'+path)
            self.assertEqual(denial.exception.code, 401)
            self.assertEqual(json.load(denial.exception), {'error': 'unauthorized'})
            denial.exception.close()
        self.assertFalse(self.calls)
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': self.auth})) as r:
            self.assertEqual(r.headers['Cache-Control'], 'no-store')
            body = json.load(r)
        self.assertEqual(body['text'], 'Implemented work. Verified it.')
        self.assertEqual(body['sourceSessionId'], 'sess-1')
        self.assertEqual(self.calls[0][1], TOKEN)
        for bad in ('/v1/pad-digest?agentId=../alpha-pm', '/v1/pad-summary?agentId=alpha-pm',
                    '/v1/pad-digest?agentId=alpha-pm&agentId=beta-pm', '/v1/pad-digest?agentId=peer'):
            with self.assertRaises(urllib.error.HTTPError) as exc:
                urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+bad,
                                                       headers={'Authorization': self.auth}))
            exc.exception.close()
        self.assertEqual(len(self.calls), 1)
        summary = f'/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId={body["digestId"]}'
        with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{server.server_port}' + summary,
                                                         headers={'Authorization': self.auth})) as r:
            audio = json.load(r)
        self.assertEqual((audio['status'], audio['sourceSessionId'], audio['digestId']),
                         ('available', 'sess-1', body['digestId']))
        self.assertEqual(audio['audio'], 'b2dnLWRhdGE=')

    def test_only_origin_relative_targets_without_fragments_reach_source(self):
        for path in (self.base + '#unrecognized', 'http://fixture.invalid' + self.base, '//fixture.invalid' + self.base):
            with self.subTest(path=path):
                self.assertEqual(self.consumer.read(path, self.auth), (400, {'error': 'invalid_request'}))
        self.assertFalse(self.calls)
        server = p.server(self.consumer, 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
        try:
            conn.request('GET', self.base + '#unrecognized', headers={'Authorization': self.auth})
            response = conn.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.load(response), {'error': 'invalid_request'})
        finally:
            conn.close()
        self.assertFalse(self.calls)

    def test_exact_session_binding_and_staleness(self):
        code, a = self.consumer.read(self.base, self.auth)
        self.assertEqual((code, a['status']), (200, 'available'))
        summary = f'/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId={a["digestId"]}'
        code, audio = self.consumer.read(summary, self.auth)
        self.assertEqual((code, audio['voice'], audio['sourceSessionId']), (200, 'owner-voice', 'sess-1'))
        self.source = digest('beta-pm', 'sess-1')
        self.assertEqual(self.consumer.read(self.base, self.auth)[0], 503)
        self.source = digest(session='sess-2')
        self.assertEqual(self.consumer.read(summary, self.auth)[0], 503)
        self.source = digest()
        self.source['sourceAt'] = '2020-01-01T00:00:00Z'
        code, old = self.consumer.read(self.base, self.auth)
        self.assertEqual((code, old['status']), (200, 'stale'))
        self.assertNotIn('text', old)
        self.assertEqual(self.consumer.read(summary, self.auth)[0], 409)
        self.source = digest(status='missing')
        self.assertEqual(self.consumer.read(self.base, self.auth)[1]['status'], 'missing')
        self.assertEqual(self.consumer.read(summary, self.auth)[0], 409)

    def test_unavailable_voice_and_changed_version_never_render(self):
        self.consumer.desk.voice_choice = lambda *a, **k: dict(effective_voice=None, source='unavailable')
        _, d = self.consumer.read(self.base, self.auth)
        path = f'/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId={d["digestId"]}'
        self.assertEqual(self.consumer.read(path, self.auth)[1]['status'], 'voice_unavailable')
        self.assertEqual(self.consumer.read(path.replace(d['digestId'], 'b'*64), self.auth)[0], 409)


    def test_render_revalidates_voice_digest_and_freshness(self):
        _, d = self.consumer.read(self.base, self.auth)
        path = f'/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId={d["digestId"]}'
        def render(text, tmp, voice):
            self.consumer.desk.voice_choice = lambda *a, **k: dict(effective_voice='changed', source='profile')
            return b'fixture-audio'
        self.consumer.render = render
        self.assertEqual(self.consumer.read(path, self.auth), (409, {'error': 'voice_changed'}))
        self.consumer.desk = Desk()
        def changed(text, tmp, voice):
            self.source['text'] = 'New substance. New version.'
            return b'fixture-audio'
        self.consumer.render = changed
        self.assertEqual(self.consumer.read(path, self.auth), (409, {'error': 'digest_changed'}))
        self.source = digest()
        def expired(text, tmp, voice):
            self.source['asOf'] = '2020-01-01T00:00:00Z'
            return b'fixture-audio'
        self.consumer.render = expired
        self.assertEqual(self.consumer.read(path, self.auth), (409, {'error': 'digest_changed'}))

    def test_projection_bounds_attribution_and_stable_identity(self):
        d = digest()
        original = p.project(d, 'alpha-pm')['digestId']
        d['generatedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        self.assertEqual(p.project(d, 'alpha-pm')['digestId'], original)
        for field, value in [('agentId', 'beta-pm'), ('sourceSessionId', ''), ('sourceThreadId', None),
                             ('sourceEventIds', []), ('sourceEventIds', ['x'] * 17), ('text', 'x' * 1201),
                             ('sourceAt', '2099-01-01T00:00:00Z')]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                p.project({**digest(), field: value}, 'alpha-pm')
        _, d = self.consumer.read(self.base, self.auth)
        path = f'/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId={d["digestId"]}'
        self.consumer.render = lambda *a: b'x' * (p.MAX_AUDIO + 1)
        self.assertEqual(self.consumer.read(path, self.auth), (503, {'error': 'unavailable'}))
        with self.assertRaises(ValueError):
            p.Consumer({}, Desk(), lambda *a: b'', jev_url='https://public.invalid')

    def test_loopback_transport_bounds_and_no_redirect(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        seen = []
        class Source(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get('Authorization')))
                self.send_response(302 if self.path == '/redirect' else 200)
                self.send_header('Location', '/must-not-follow')
                self.end_headers()
                self.wfile.write(b'x' * (p.MAX_JSON + 1) if self.path == '/large' else json.dumps(digest()).encode())
            def log_message(self, format, *args):
                pass
        srv = ThreadingHTTPServer(('127.0.0.1', 0), Source)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        base = f'http://127.0.0.1:{srv.server_port}'
        self.assertEqual(p.read_json(base + '/valid', TOKEN)['agentId'], 'alpha-pm')
        self.assertEqual(seen[-1][1], self.auth)
        with self.assertRaises(ValueError):
            p.read_json(base + '/large', TOKEN)
        with self.assertRaises(ValueError):
            p.read_json(base + '/redirect', TOKEN)
        self.assertFalse(any(path == '/must-not-follow' for path, _ in seen))

    def test_timezone_aware_source_and_projection_ages(self):
        now = time.time()
        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat()
        source = {**digest(), **{k: iso(now) for k in ('sourceAt', 'generatedAt', 'asOf')}}
        self.assertEqual(p.project(source, 'alpha-pm', now=now)['status'], 'available')
        for field in ('sourceAt', 'generatedAt', 'asOf'):
            with self.subTest(field=field):
                self.assertEqual(p.project({**source, field: iso(now - 7201)}, 'alpha-pm', now=now)['status'], 'stale')
                with self.assertRaises(ValueError):
                    p.project({**source, field: iso(now + 6)}, 'alpha-pm', now=now)
                with self.assertRaises(ValueError):
                    p.project({**source, field: iso(now).replace('+00:00', '')}, 'alpha-pm', now=now)
        offset = datetime.fromtimestamp(now, timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30))).isoformat()
        self.assertAlmostEqual(p.stamp(offset), now, places=5)

    def test_actual_jev_producer_to_authenticated_consumer_http(self):
        import importlib.util
        source = Path.home() / '.agents/tools/jev-clairic/bin/jev_session_digest.py'
        self.assertTrue(source.is_file(), 'Jev contract integration requires the authoritative producer')
        spec = importlib.util.spec_from_file_location('holoc51_fixture_jev', source)
        assert spec is not None and spec.loader is not None
        jev = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(jev)
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory(prefix='pad-jev-integration-') as tmp:
            root = Path(tmp)
            registry, state = root / 'registry.yaml', root / jev.STATE_NAME
            registry.write_text('agents:\n  alpha-pm:\n    type: hermes\n    profile_name: alpha-pm\n')
            completed = dict(id='source-1', type=jev.COMPLETED, time=now.isoformat(), producer='hermes-agent:alpha-pm',
                             correlationid='session-1', data={'thread_id': 'thread-1', 'reply_text': 'Not exported.'})
            annotated = dict(id='annotation-1', type=jev.ANNOTATED, time=now.isoformat(), producer='turn-enricher',
                             correlationid='session-1', data={'thread_id': 'thread-1', 'target_event_id': 'source-1',
                             'action': 'Checked fixture integration', 'artifacts': [], 'blocker': 'none'})
            jev.project([annotated], [completed], state, registry, now)
            upstream = jev.serve(state, registry, {'fixture': TOKEN}, port=0)
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            try:
                endpoint = f'http://127.0.0.1:{upstream.server_port}'
                record = p.read_json(endpoint + '/v1/agent-session-digest?agentId=alpha-pm', TOKEN)
                self.assertTrue(record['sourceAt'].endswith('+00:00'))
                consumer = p.Consumer({'fixture': TOKEN}, Desk(), lambda *a: b'fixture-audio', jev_url=endpoint,
                                      route=lambda _: {'ok': True})
                downstream = p.server(consumer, 0)
                threading.Thread(target=downstream.serve_forever, daemon=True).start()
                try:
                    url = f'http://127.0.0.1:{downstream.server_port}/v1/pad-digest?agentId=alpha-pm'
                    with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': self.auth})) as response:
                        body = json.load(response)
                    self.assertEqual((body['status'], body['sourceSessionId'], body['text']),
                                     ('available', 'session-1', record['text']))
                    self.assertGreater(body['expiresAt'], time.time() * 1000)
                    with self.assertRaises(urllib.error.HTTPError) as denial:
                        urllib.request.urlopen(url)
                    self.assertEqual(denial.exception.code, 401)
                    denial.exception.close()
                finally:
                    downstream.shutdown(); downstream.server_close()
            finally:
                upstream.shutdown(); upstream.server_close()

    def test_final_voice_resolution_cannot_outlive_projection(self):
        now = time.time()
        clock = [now]
        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat()
        self.source = {**digest(), 'sourceAt': iso(now), 'generatedAt': iso(now - 7199), 'asOf': iso(now - 7199)}
        calls = []
        class FinalVoice:
            def voice_choice(self, *a, **kw):
                calls.append(1)
                if len(calls) == 2:
                    clock[0] += 2
                return dict(effective_voice='fixture', source='profile')
        self.consumer.desk = FinalVoice()
        self.consumer.clock = lambda: clock[0]
        version = p.project(self.source, 'alpha-pm', now=now)['digestId']
        assert isinstance(version, str)
        result = self.consumer.read('/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId=' + version, self.auth)
        self.assertEqual(result, (409, {'error': 'digest_changed'}))
        self.assertEqual(len(calls), 2)
        self.assertTrue(self.consumer.slots.acquire(blocking=False))
        self.consumer.slots.release()

    def test_real_source_total_deadline_covers_dripping_headers_and_body_and_releases_slots(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        class Slow(BaseHTTPRequestHandler):
            def do_GET(self):
                try:
                    if self.path.startswith('/headers'):
                        self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Fixture: '); self.wfile.flush()
                    else:
                        self.send_response(200); self.end_headers()
                    for _ in range(15):
                        self.wfile.write(b' '); self.wfile.flush(); time.sleep(.05)
                    self.wfile.write(b'\r\n\r\n{}' if self.path.startswith('/headers') else b'{}')
                except OSError:
                    pass
            def log_message(self, format, *args): pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Slow)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
        endpoint = f'http://127.0.0.1:{upstream.server_port}'
        for path in ('/headers', '/body'):
            start = time.monotonic()
            with self.assertRaises((TimeoutError, ValueError, OSError, http.client.HTTPException)):
                p.read_json(endpoint + path, TOKEN, timeout=.2)
            self.assertLess(time.monotonic() - start, .6)
        consumer = p.Consumer({'fixture': TOKEN}, Desk(), lambda *a: b'',
                              fetch=lambda *a: p.read_json(endpoint + '/body', TOKEN, timeout=.2), route=lambda _: {'ok': True})
        for _ in range(3):
            self.assertEqual(consumer.read(self.base, self.auth), (503, {'error': 'unavailable'}))
        self.assertTrue(consumer.slots.acquire(blocking=False)); consumer.slots.release()
        consumer.fetch = lambda *a: digest()
        self.assertEqual(consumer.read(self.base, self.auth)[0], 200)

    def test_authoritative_profile_assignment_and_emergency_fallback(self):
        from test_converse import cv
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = root / 'registry.yaml'
            registry.write_text('agents:\n  alpha-pm: {profile_name: alpha-profile}\n')
            profiles = root / 'profiles'
            config = profiles / 'alpha-profile/config.yaml'
            config.parent.mkdir(parents=True)
            config.write_text('tts: {voice: owner-voice, vox: {voice: wrong-nested}}\n')
            catalog = cv.VoiceCatalog(fetch=lambda timeout: [{'name': v} for v in ('owner-voice', 'rick')])
            catalog.get()
            desk = cv.Desk(root, cards=cv.CardCache(registry, profiles, root / 'roster.json', recall=None),
                           voices=catalog, tools=cv.ToolBox(root / 'no-tools'), log=lambda *a, **kw: None)
            self.consumer.desk = desk
            rendered = []
            self.consumer.render = lambda text, tmp, voice: rendered.append(voice) or b'fixture-audio'
            _, d = self.consumer.read(self.base, self.auth)
            path = f'/v1/pad-summary?agentId=alpha-pm&sourceSessionId=sess-1&digestId={d["digestId"]}'
            with patch.dict('os.environ', {'MEMO_VOX_VOICE': 'rick', 'MEMO_PROGRESS_VOICE': 'wrong-tile'}):
                self.assertEqual(self.consumer.read(path, self.auth)[1]['voice'], 'owner-voice')
                config.unlink()
                self.assertEqual(self.consumer.read(path, self.auth)[1]['voice'], 'rick')
            self.assertEqual(rendered, ['owner-voice', 'rick'])

    def test_bounded_real_synthesize_and_gate(self):
        from test_inbox_watcher import iw
        # Exercise production transport with labelled local bytes; never call live vox or a bus.
        real = iw.synthesize
        audio = b'fixture-not-a-real-clip' * 20
        meta = json.dumps({'audio_url': 'http://fixture/audio', 'engine': 'fixture'}).encode()
        class Response(io.BytesIO):
            pass
        with tempfile.TemporaryDirectory() as tmp, patch.object(iw, 'TTS_GATE', iw.TtsGate()), patch.object(iw.mc_, 'vox_headers', return_value={}):
            for bodies, expected in [([meta, audio], None), ([b'x' * 16385], 'metadata exceeds limit'),
                                     ([meta, b'x' * 1025], 'audio exceeds limit')]:
                with patch('urllib.request.urlopen', side_effect=[Response(b) for b in bodies]):
                    if expected:
                        with self.assertRaisesRegex(iw.StageError, expected):
                            real('Fixture only.', Path(tmp), voice='fixture', timeout=.1, max_bytes=1024)
                    else:
                        file, engine = real('Fixture only.', Path(tmp), voice='fixture', timeout=.1, max_bytes=1024)
                        self.assertEqual((file.read_bytes(), engine), (audio, 'fixture'))
            with iw.TTS_GATE.hold(iw.TtsGate.REPLY):
                with self.assertRaises(TimeoutError):
                    with iw.TTS_GATE.hold(iw.TtsGate.REPLY, timeout=.01):
                        self.fail('busy gate must time out')
                self.assertEqual(iw.TTS_GATE.waiting(), 0)


if __name__ == '__main__':
    unittest.main()
