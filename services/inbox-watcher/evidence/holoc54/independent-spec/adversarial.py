"""Read-only adversarial reproduction on frozen watcher with fake registry, profiles and synth."""
import json
import sys
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0, '/home/delorenj/code/33GOD/holocene/.worktrees/holoc-54-agent-voice-local/services/inbox-watcher')
from test_assigned_voices import AssignedVoices
from test_inbox_watcher import iw

case = AssignedVoices('test_distinct_assignments_top_level_precedence_and_alias')
case.setUp()
try:
    m = case.memo(reply_stamp='one')
    old = case.w._voice_choice
    def responder_changes_during_resolution(memo, *a, **kw):
        choice = old(memo, *a, **kw)
        memo['agent'] = 'tile-b'
        return choice
    with patch.object(case.w, '_voice_choice', side_effect=responder_changes_during_resolution):
        got = case.w._reply_voice(m)
    print(json.dumps({'case': 'responder changes between resolver and final lock write', 'resolved_voice': got,
        'actual_responding_agent': case.w._responding_agent(m), 'lock': m['voice_lock'],
        'expected_voice': case.desk.voice_choice('tile-b', 'rick')['voice']}, sort_keys=True))

    m2 = case.memo(reply_stamp='one')
    def stamp_changes_during_resolution(memo, *a, **kw):
        choice = old(memo, *a, **kw)
        case.config('holocene-pm', 'tts: {voice: walken}\n')
        memo['reply_stamp'] = 'two'
        return choice
    with patch.object(case.w, '_voice_choice', side_effect=stamp_changes_during_resolution):
        got2 = case.w._reply_voice(m2)
    print(json.dumps({'case': 'stamp and assignment change between resolver and final lock write', 'resolved_voice': got2,
        'actual_stamp': m2['reply_stamp'], 'lock': m2['voice_lock'],
        'expected_voice': case.desk.voice_choice('tile-a', 'rick')['voice']}, sort_keys=True))
    legacy = case.memo(agent='tile-b', reply_stamp='one', voice_lock={'stamp': 'one', 'voice': 'carlin', 'profile': 'holocene-pm'})
    print(json.dumps({'case': 'resumed pre-checkpoint lock lacking identity after responder changed',
        'resolved_voice': case.w._reply_voice(legacy), 'actual_responding_agent': case.w._responding_agent(legacy),
        'expected_voice': case.desk.voice_choice('tile-b', 'rick')['voice']}, sort_keys=True))
    m3 = case.memo(reply_stamp='one')
    case.config('holocene-pm', 'tts: {voice: carlin}\n')
    def cue_responder_changes(memo, *a, **kw):
        choice = old(memo, *a, **kw)
        memo['agent'] = 'tile-b'
        return choice
    with patch.object(case.w, '_voice_choice', side_effect=cue_responder_changes):
        cue = case.w._cue_voice(m3)
    print(json.dumps({'case': 'responder changes during pending cue resolution', 'resolved_voice': cue['voice'],
        'actual_responding_agent': case.w._responding_agent(m3), 'pending_lock': m3['cue_voice_lock'],
        'expected_voice': case.desk.voice_choice('tile-b', 'rick')['voice']}, sort_keys=True))
finally:
    case.doCleanups()
