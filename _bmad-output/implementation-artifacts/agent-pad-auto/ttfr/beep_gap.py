import json,sys
off=-1.293
pk=[json.loads(l) for l in open('/tmp/ttfr/tap.jsonl')]
lines=open('/tmp/ttfr/logcat2.txt',errors='replace').read().splitlines()
lo,hi=float(sys.argv[1]),float(sys.argv[2])
ev=[]
for l in lines:
    if 'HoloceneWheel: tone START' in l or 'mic=recording reason=recording' in l:
        t=float(l.split()[0])
        if lo<t<hi: ev.append((t,'out' if 'out after' in l else ('play' if 'tone START' in l else 'mic')))
cyc=[];cur={}
for t,k in ev:
    cur[k]=t
    if k=='mic': cyc.append(cur); cur={}
for c in cyc:
    if 'play' not in c: continue
    s=c['play']
    tone=[(p['t']+off, p['t']+off+p['n']/16000) for p in pk if s+0.2 < p['t']+off < s+1.2 and p['rms']>300]
    end=max(b for a,b in tone)
    print("play %.3f  beep audible %3.0f..%3.0f ms  tone over %3.0f ms  mic open %3.0f ms  => beep's last sound -> mic %+4.0f ms" % (s,(tone[0][0]-s)*1000,(end-s)*1000,(c['out']-s)*1000,(c['mic']-s)*1000,(c['mic']-end)*1000))
