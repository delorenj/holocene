"""D2 headroom bench (HOLOC-23): live desk calls through the watcher's own Desk.decide with the unit's route AS IN THE UNIT FILE
(timeout / budget read from it), on the current conversation shape: a fresh conversation, and a 10-turn conversation with a
pending-draft-free state, asking questions and work requests (proposes). One JSON line per call: wall ms, path, action,
served model, per-attempt outcomes. Never Anthropic: the desk's own scope / route / model checks run.
usage: python3 d2_headroom_bench.py [rounds]"""
import json, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, "/home/delorenj/code/33GOD/holocene/services/inbox-watcher")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import converse as cv  # noqa: E402
from d1_bench import TapHttp, unit_env  # noqa: E402

TURNS = [
    ("What is Holocene working on right now?", "reply", "Holocene is on the car desk: the fast conversation layer for the phone."),
    ("And what's the state of the watcher stage?", "reply", "The watcher stage is live and serving memos."),
    ("Which agents are on my roster?", "reply", "Holocene PM, the flume PM, and a few others."),
    ("How long does a reply usually take?", "reply", "Three to seven seconds for the desk, longer for a full agent turn."),
    ("Is the hold cue on?", "reply", "Yes, the hold cue is on."),
    ("What did we ship yesterday?", "reply", "The delegation read-back and the in-flight window."),
    ("Does the phone get a copy of the read-back?", "reply", "Yes, through the phone retry."),
    ("What is the budget for the desk call?", "reply", "Fourteen seconds."),
    ("Could the desk time out on a long question?", "reply", "It could, then it falls through to the full agent."),
    ("What would that skip?", "reply", "The propose and confirm step."),
]
ASKS = [
    ("q-fresh", 0, "What is the Holocene project, in one sentence?"),
    ("propose-fresh", 0, "Have the Holocene PM raise the desk timeout and add a third hold cue, then tell me when it's done."),
    ("q-10", 10, "Remind me which stage the memo watcher is in and what is left."),
    ("propose-10a", 10, "Forget that. Have the Holocene PM write up a short summary of everything we just discussed and file it on the board."),
    ("propose-10b", 10, "Ask the flume PM to check why the gateway serves glm-5.3 at max effort and report back what it finds."),
    ("propose-10c", 10, "Tell the Holocene PM to rerun the full test suite and the live check, and fix whatever fails."),
]


def sess_of(n):
    turns = [{"kind": "driver", "memo_id": f"m{i}", "user": u, "say": s, "action": a} for i, (u, a, s) in enumerate(TURNS[:n])]
    return {"turns": turns} if turns else None


def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    env = unit_env()
    http = TapHttp()
    desk = cv.Desk(Path(tempfile.mkdtemp(prefix="d2bench-")), env=env, http_=http, log=lambda *a, **k: None)
    desk.warm_keys()
    s = desk.settings()
    r1 = desk.ladder(s, "holocene-pm")
    print(json.dumps({"unit": {"routes": [(r["id"], r["model"], r["timeout_s"]) for r in r1.routes] if hasattr(r1, "routes") else None,
                               "budget_s": desk.budget_s, "reask_min_s": desk.reask_min_s}}), flush=True)
    card = desk.cards.build("holocene-pm")
    for i in range(rounds):
        for key, n, text in ASKS:
            http.last.clear()
            t0 = time.time()
            raw = desk.decide(s, agent="holocene-pm", name="Holocene PM", transcript=text, sess=sess_of(n), card=card)
            llm = raw.get("llm") or {}
            print(json.dumps({"i": i, "ask": key, "turns": n, "path": raw["path"], "wall_ms": int((time.time() - t0) * 1000),
                              "action": raw["decision"].get("action"), "fallback_reason": raw.get("fallback_reason"),
                              "prompt_chars": raw.get("prompt_chars"),
                              "attempts": [{k: a.get(k) for k in ("route", "model", "outcome", "ms", "reask", "finish_reason", "completion_tokens", "reasoning_tokens")} for a in (llm.get("attempts") or [])],
                              "served": [c.get("model") for c in http.last], "say": (raw["decision"].get("say") or "")[:90]}, default=str), flush=True)
            time.sleep(1.0)


if __name__ == "__main__":
    main()
