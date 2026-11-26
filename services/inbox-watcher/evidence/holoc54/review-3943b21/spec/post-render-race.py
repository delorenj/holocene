"""Read-only bounded race reproduction against the exact watcher candidate."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, '/home/delorenj/code/33GOD/holocene/.worktrees/holoc-54-agent-voice-local/services/inbox-watcher')
from test_assigned_voices import AssignedVoices
from test_inbox_watcher import iw

case = AssignedVoices('test_distinct_assignments_top_level_precedence_and_alias')
case.setUp()
try:
    m = case.memo(agent='tile-a', sender={'ok': True, 'host': 'car'}, reply_stamp='2026-11-22T01:00:00Z',
                  reply_text='Fixture reply.', received_ts=0, status='active', stage='speak')
    case.w.done_stage = Mock()
    case.w.fact_fast = Mock()
    original = case.w._synth
    def change_after_render(memo, *args, **kwargs):
        result = original(memo, *args, **kwargs)
        with case.w.mu:
            memo['agent'] = 'tile-b'
            memo['command_id'] = 'cmd-b'
        return result
    with patch.object(case.w, '_synth', side_effect=change_after_render), \
         patch.object(iw.mc_, 'mc', return_value=SimpleNamespace(returncode=0, stderr='')) as upload, \
         patch.object(iw.mc_, 's3_stat', return_value={'size': 200}):
        case.w.step_speak(m)
    print(json.dumps({'case': 'responder changes after render validation, before upload',
                      'uploaded': upload.call_count, 'selected_voice': m['voice_lock']['voice'],
                      'lock_identity': m['voice_lock']['identity'],
                      'current_identity': case.w._voice_identity(m),
                      'voiced_fact': case.w.fact_fast.call_count,
                      'expected_current_voice': case.desk.voice_choice('tile-b', 'rick')['voice']}, sort_keys=True))
finally:
    case.doCleanups()
