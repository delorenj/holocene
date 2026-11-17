#!/usr/bin/env python3
"""Run bounded HOLOC-37 cases on the verified private emulator only."""
import subprocess, json, time, datetime, pathlib
ROOT=pathlib.Path(__file__).parent
ADB=str(pathlib.Path.home()/'Android/Sdk/platform-tools/adb')
SER='emulator-5580'
assert subprocess.check_output([ADB,'-s',SER,'shell','getprop','ro.build.version.sdk'],text=True).strip()=='37'
assert subprocess.check_output([ADB,'-s',SER,'shell','getprop','ro.build.fingerprint'],text=True).startswith('google/sdk_gphone64_x86_64/')

def run(*args):
    p=subprocess.run([ADB,'-s',SER,*args],capture_output=True,text=True,timeout=40)
    return {'command':'adb -s '+SER+' '+' '.join(args),'exit':p.returncode,'stdout':p.stdout.strip(),'stderr':p.stderr.strip()}

def capture(name):
    lines=run('logcat','-d','-v','time')['stdout'].splitlines()
    keys=('AudioHardening','requestAudioFocus() from uid/pid 10234','abandonAudioFocus() from uid/pid 10234','setStreamVolume()','earshot/Earshot','sh.delo.earshot.PlaybackController','FATAL EXCEPTION','MODE_IN_CALL','MODE_NORMAL')
    (ROOT/f'holoc37-{name}-logcat.txt').write_text('\n'.join(x for x in lines if any(y in x for y in keys))+'\n')

def add(name,key,permission='default',call=False):
    commands=[]
    commands.append(run('shell','cmd','appops','set','sh.delo.earshot','SCHEDULE_EXACT_ALARM',permission))
    commands.append(run('shell','cmd','appops','get','sh.delo.earshot','SCHEDULE_EXACT_ALARM'))
    commands.append(run('shell','dumpsys','power'))
    commands[-1]['stdout']='\n'.join(x for x in commands[-1]['stdout'].splitlines() if 'mWakefulness=' in x)
    commands.append(run('shell','dumpsys','activity','services','sh.delo.earshot'))
    commands[-1]['stdout']='\n'.join(x.strip() for x in commands[-1]['stdout'].splitlines() if 'isForeground=' in x or 'getFgsAllowWiu_for' in x or 'infoAllowStartForeground=' in x)
    commands.append(run('logcat','-c'))
    if call:
        commands.append(run('emu','gsm','call','5551234'))
        time.sleep(5)
        commands.append(run('shell','dumpsys','audio'))
        commands[-1]['stdout']='\n'.join(x.strip() for x in commands[-1]['stdout'].splitlines() if 'Actual mode =' in x or 'Requested mode =' in x)
    p=ROOT/'holoc37-items.json'
    data=json.loads(p.read_text())
    data.append({'key':key,'modified':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')})
    p.write_text(json.dumps(data))
    commands.append({'command':f'write fixture {p}: {key} with current UTC LastModified','exit':0,'stdout':data[-1]['modified'],'stderr':''})
    time.sleep(5 if call else 12)
    if call:
        commands.append(run('emu','gsm','cancel','5551234'))
        time.sleep(12)
    capture(name)
    beacons=ROOT/'holoc37-beacons.jsonl'
    relevant=[json.loads(x) for x in beacons.read_text().splitlines() if key in x] if beacons.exists() else []
    (ROOT/f'holoc37-{name}-result.json').write_text(json.dumps({'name':name,'key':key,'commands':commands,'beacons':relevant},indent=2)+'\n')
    print(name,[(x.get('phase'),x.get('at'),x.get('error')) for x in relevant], 'call_mode',next((x['stdout'] for x in commands if x['command'].endswith('dumpsys audio')),'not tested'),flush=True)

add('alarm-no-permission','alarm/holoc37-no-permission.wav')
add('alarm-appops-allow-no-manifest','alarm/holoc37-appops-allow.wav','allow')
add('call-hold-replay','phone/holoc37-call.wav',call=True)
