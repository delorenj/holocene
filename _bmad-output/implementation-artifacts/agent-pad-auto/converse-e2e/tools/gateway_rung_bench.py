import sys, json, time, statistics, urllib.request, subprocess
sys.path.insert(0, '/home/delorenj/code/33GOD/holocene/services/inbox-watcher')
import converse as cv
K = subprocess.run(['op','read','op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/holocene-converse'],capture_output=True,text=True).stdout.strip()
card = {"text": "AGENT: Holocene PM\n" + ("MEMORY: Holocene is the 33GOD dashboard; voice memos route through the inbox watcher; the fast desk answers in the car. " * 18), "roster": "- flume-pm: Flume PM\n" * 40}
msgs = cv.build_messages(agent="holocene-pm", name="Holocene PM", card=card, sess=None, transcript="Which of those would handle the voice pipeline?")
n = int(sys.argv[1]); models = sys.argv[2:]
for m in models:
    ts = []; ok = 0; codes = []
    for i in range(n):
        body = {"model": m, "messages": msgs, "response_format": {"type": "json_object"}, "temperature": 0.3, "max_tokens": 700, "stream": False}
        req = urllib.request.Request("https://api.automaticai.io/v1/chat/completions", data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + K, "Content-Type": "application/json", "User-Agent": "holocene-converse-bench"})
        t0 = time.time()
        try:
            r = urllib.request.urlopen(req, timeout=15); d = json.loads(r.read()); dt = time.time() - t0
            c = d["choices"][0]["message"].get("content") or ""
            try: cv.parse_decision(c); ok += 1
            except Exception: pass
            ts.append(dt); codes.append(200)
        except Exception as e:
            codes.append(str(getattr(e, 'code', type(e).__name__))); ts.append(time.time() - t0)
        time.sleep(0.3)
    ts2 = sorted(ts)
    print(f"{m:58s} p50 {statistics.median(ts):.2f} p90 {ts2[int(0.9*(len(ts2)-1))]:.2f} max {ts2[-1]:.2f} ok {ok}/{n} codes {sorted(set(map(str,codes)))}", flush=True)
