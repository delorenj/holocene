"""Scratch-only adversarial checks against unchanged candidate and mocked fixture."""
import json
import threading
from test_assigned_voices import AssignedVoices, iw

def run():
    c = AssignedVoices()
    c.setUp()
    try:
        m = c.memo(reply_stamp='one', status='active')
        first = c.w._synth(m, 'first chunk', c.root)
        with c.w.mu:
            m['voiced_n'] = 1
            m['voiced_keys'] = {'1':'fixture-first'}
            m.update(agent='tile-b', command_id='cmd-b')
        try:
            second = c.w._synth(m, 'second chunk', c.root)
            result = {'second_voice': c.renders[-1][1], 'second_error': None}
        except iw.StageError as exc:
            result = {'second_voice': None, 'second_error': exc.code}
        result.update(first_voice=c.renders[0][1], voice_lock=m.get('voice_lock'), voiced_n=m.get('voiced_n'), previously_announced=m.get('voiced_keys'))
        print(json.dumps(result, indent=2))
    finally:
        c.doCleanups()
run()
