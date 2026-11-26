"""Adversarial unchanged candidate execution. No real synthesis/delivery/writer."""
import io
import json
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path('/home/delorenj/code/33GOD/holocene/.worktrees/holoc-54-agent-voice-local')
ROOT = Path('/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc54-quality')
sys.path.insert(0,str(REPO/'services/inbox-watcher'))
from test_assigned_voices import AssignedVoices, iw, cv

RESULTS = []

def fixture():
    c = AssignedVoices()
    c.setUp()
    return c

def run_case(name, fn):
    c=fixture()
    try:
        detail=fn(c)
        RESULTS.append({'case':name, **detail})
    finally:
        c.doCleanups()

def stale_resolution(c, change):
    m=c.memo(reply_stamp='one')
    entered,release=threading.Event(),threading.Event()
    out={}
    real=c.w._voice_choice
    def blocked(memo,*args,**kwargs):
        choice=real(memo,*args,**kwargs)
        entered.set()
        assert release.wait(3)
        return choice
    def worker():
        try: out['voice']=c.w._reply_voice(m)
        except BaseException as e: out['error']=repr(e)
    with patch.object(c.w,'_voice_choice',side_effect=blocked):
        t=threading.Thread(target=worker)
        t.start()
        assert entered.wait(3)
        with c.w.mu: change(c,m)
        release.set(); t.join(4); assert not t.is_alive()
    selected=c.w._reply_voice(m)
    assigned=c.w._voice_choice(m)['voice']
    return {'returned':out,'memo_identity':c.w._voice_identity(m),'stamp':m.get('reply_stamp'),
            'lock':m.get('voice_lock'),'next_call_voice':selected,'current_assignment':assigned,
            'defect_observed': selected!=assigned}

def responder_change(c):
    def change(c,m): m.update(agent='tile-b',command_id='cmd-b')
    return stale_resolution(c,change)

def same_responder_new_command(c):
    def change(c,m):
        c.config('holocene-pm','tts: {voice: walken}\n')
        m.update(command_id='cmd-next',reply_stamp='two')
    return stale_resolution(c,change)

def cue_slow_resolver(c):
    m=c.memo(reply_stamp='one')
    entered,release=threading.Event(),threading.Event(); out={}
    real=c.w._voice_choice
    def blocked(memo,*args,**kwargs):
        choice=real(memo,*args,**kwargs); entered.set(); assert release.wait(3); return choice
    def worker():
        try: out['rendered']=c.w._synth_cue(m,'Working.',c.root,iw.PROGRESS_TTS_STEPS,progress=True)
        except BaseException as e: out['error']=repr(e)
    with patch.object(c.w,'_voice_choice',side_effect=blocked):
        t=threading.Thread(target=worker); t.start(); assert entered.wait(3)
        with c.w.mu: m.update(agent='tile-b',command_id='cmd-b',reply_stamp='two')
        release.set(); t.join(4); assert not t.is_alive()
    choice=out.get('rendered',[None,None,None])[2]
    return {'renders':c.renders,'returned_choice':choice,'error':out.get('error'),
            'current_identity':c.w._voice_identity(m),'current_assignment':c.w._voice_choice(m)['voice'],
            'defect_observed':bool(choice and choice['voice']!='brule')}

def delayed_cue_after_final(c):
    # Slow optional catalog call captured carlin, final pins carlin first; cue lock
    # creation then reintroduces a pending lock and its 404 changes that to rick.
    m=c.memo(reply_stamp='one')
    entered,release=threading.Event(),threading.Event(); out={}
    real=c.w._voice_choice
    def blocked(memo,*args,**kwargs):
        choice=real(memo,*args,**kwargs); entered.set(); assert release.wait(3); return choice
    def worker():
        try: out['choice']=c.w._cue_voice(m)
        except BaseException as e: out['error']=repr(e)
    with patch.object(c.w,'_voice_choice',side_effect=blocked):
        t=threading.Thread(target=worker); t.start(); assert entered.wait(3)
        # Real resolver through a second call, not a replacement lock implementation.
        with patch.object(c.w,'_voice_choice',side_effect=real):
            c.w._reply_voice(m)
        release.set(); t.join(4); assert not t.is_alive()
    old=out['choice']; old.update(cue_stamp=m.get('reply_stamp'),cue_identity=c.w._voice_identity(m))
    fallback=c.w._missing_voice(m,old,cue=True)
    return {'cue_choice':old,'fallback':fallback,'final_lock':m.get('voice_lock'),
            'pending_lock':m.get('cue_voice_lock'),'defect_observed':fallback is not None}

def midrender_responder(c):
    m=c.memo(reply_stamp='one')
    entered,release=threading.Event(),threading.Event(); out={}
    def render(text,tmp,**kw):
        entered.set(); assert release.wait(3); return c.fake_synth(text,tmp,**kw)
    def worker():
        try: out['result']=str(c.w._synth(m,'Old agent final.',c.root)[0])
        except BaseException as e: out['error']=repr(e)
    with patch.object(iw,'synthesize',side_effect=render):
        t=threading.Thread(target=worker); t.start(); assert entered.wait(3)
        with c.w.mu: m.update(agent='tile-b',command_id='cmd-b')
        release.set(); t.join(4); assert not t.is_alive()
    return {'out':out,'voice_lock':m['voice_lock'],'current_identity':c.w._voice_identity(m),
            'defect_observed':'error' not in out}

def symlink_swap(c):
    outside=c.root/'outside'; outside.mkdir(); target=outside/'config.yaml'
    target.write_text('tts: {voice: walken}\nsecret: DO_NOT_LEAK_FIXTURE\n')
    path=c.profiles/'holocene-pm'/'config.yaml'
    real=c.cards.profile_config
    def swap(p):
        path.unlink(); path.symlink_to(target); return real(p)
    with patch.object(c.cards,'profile_config',side_effect=swap): choice=c.choice()
    return {'choice':choice,'defect_observed':choice['voice']=='walken',
            'sentinel_leaked':'DO_NOT_LEAK_FIXTURE' in json.dumps(choice)}

def channels(c):
    rows=[]
    c.desk.flag.path.write_text(json.dumps({'tiles':{'tile-a':{'voice':'rick','model':'free','custom':'keep'},'tile-b':{'voice':'walken'}}}))
    for host in ('car','browser','telegram'):
        for agent,expected in [('tile-a','carlin'),('tile-b','brule')]:
            m=c.memo(agent=agent,sender={'ok':True,'host':host},profile='not-authoritative',reply_stamp=host)
            c.w._synth(m,'Mock reply '+agent,c.root)
            assert m['voice_lock']['voice']==expected
            rows.append({'transport':host,'agent':agent,'voice':m['voice_lock']['voice'],'profile':m['voice_lock']['profile']})
    for model in ('deepseek-pro',None):
        cv.update_tile(c.desk.flag.path,'tile-a',model=model)
    tile=json.loads(c.desk.flag.path.read_text())['tiles']['tile-a']
    assert tile['voice']=='rick' and tile['custom']=='keep' and 'model' not in tile
    return {'rows':rows,'model_clear_preserved':tile,'defect_observed':False}

for name,fn in [('two_agent_three_mocked_channels_model_preservation',channels),
                ('stale_resolver_different_responder',responder_change),
                ('stale_resolver_same_responder_new_round',same_responder_new_command),
                ('stale_cue_slow_resolver_new_responder',cue_slow_resolver),
                ('delayed_cue_creation_after_final_lock',delayed_cue_after_final),
                ('responder_change_during_final_render',midrender_responder),
                ('profile_symlink_swap_after_validation',symlink_swap)]:
    run_case(name,fn)
path=ROOT/'adversarial-results.json'
path.write_text(json.dumps(RESULTS,indent=2))
print(json.dumps(RESULTS,indent=2))
