"""D1 bench: live desk calls through the watcher's own Desk.decide (same card, prompt, ladder and budget as the unit),
with route variants, for the long-answer prompts that fell through in the final regression (r3-a, r3a-a) and two
short card questions as a control.

usage: python3 d1_bench.py <variant> <n> [prompt-keys...]
  variant: unit (the unit's route as found) | med (reasoning_effort medium, max_tokens 1200) | med700 | big (max_tokens 1600)
           | cut (max_tokens 300); suffixes -oldprompt (rules without the long-answer line), -noreask
  every call: outcome, ms, served route, effort, completion tokens, finish_reason, the say (head)
Writes one JSON line per call to stdout. Calls the AutomaticAI gateway with the holocene-converse token (never Anthropic:
the desk's own checks run)."""
import json, re, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, "/home/delorenj/code/33GOD/holocene/services/inbox-watcher")
import converse as cv  # noqa: E402

UNIT = Path("/home/delorenj/code/33GOD/holocene/services/inbox-watcher/holocene-inbox-watcher.service")
PROMPTS = {
    "r3a": "Walk me through the Holocene serving path and the change workflow, step by step, in some detail.",
    "r3aa": "Explain in detail, in a few sentences, what the fast desk does, how drafts work, and how sending to an agent works. Take your time.",
    "q1": "What is the Holocene project, in one sentence?",
    "q2": "Which agents are on my roster?",
}


def unit_env() -> dict:
    env = {}
    for line in UNIT.read_text().splitlines():
        if not line.startswith("Environment="):
            continue
        v = line[len("Environment="):]
        if v.startswith("'") and v.endswith("'"):
            v = v[1:-1]
        k, _, val = v.partition("=")
        env[k] = val.replace("%h", str(Path.home()))
    return env


class TapHttp(cv.Http):
    def __init__(self):
        super().__init__()
        self.last = []

    def post_json(self, url, body, headers, timeout, resp_headers=None):
        box = {} if resp_headers is None else resp_headers
        st, raw, err = super().post_json(url, body, headers, timeout, box)
        rec = {"status": st, "err": err, "route_hdr": box.get("x-automaticai-route"),
               "sent_effort": body.get("reasoning_effort"), "sent_max_tokens": body.get("max_tokens"),
               "reask": any("cut off" in (m.get("content") or "") for m in body.get("messages", []) if m.get("role") == "user")}
        try:
            d = json.loads(raw.decode("utf-8", "replace"))
            ch = (d.get("choices") or [{}])[0]
            rec.update(model=d.get("model"), finish=ch.get("finish_reason"),
                       ct=(d.get("usage") or {}).get("completion_tokens"),
                       rt=((d.get("usage") or {}).get("completion_tokens_details") or {}).get("reasoning_tokens"),
                       auto={k: v for k, v in d.items() if k.startswith("automaticai")} or None,
                       content_chars=len((ch.get("message") or {}).get("content") or ""))
        except Exception:  # noqa: BLE001
            pass
        self.last.append(rec)
        return st, raw, err


def main():
    variant, n = sys.argv[1], int(sys.argv[2])
    keys = sys.argv[3:] or list(PROMPTS)
    env = unit_env()
    routes = json.loads(env["MEMO_CONVERSE_ROUTES"])
    if variant.endswith("-noreask"):
        env["MEMO_CONVERSE_REASK_MIN_S"] = "0"
        variant = variant[: -len("-noreask")]
    if variant.endswith("-oldprompt"):  # the rules before the long-answer line (A/B of the prompt alone)
        cv.SYSTEM_RULES = "\n".join(l for l in cv.SYSTEM_RULES.split("\n") if not l.startswith("- A request for a long"))
        variant = variant[: -len("-oldprompt")]
    if variant == "med":
        routes[0].update(reasoning_effort="medium", max_tokens=1200)
    elif variant == "med700":
        routes[0].update(reasoning_effort="medium")
    elif variant == "cut":  # forces a length cut on the first attempt: measures the re-ask itself
        routes[0].update(max_tokens=300)
    elif variant == "big":
        routes[0].update(max_tokens=1600)
    elif variant != "unit":
        raise SystemExit(f"unknown variant {variant}")
    env["MEMO_CONVERSE_ROUTES"] = json.dumps(routes)
    http = TapHttp()
    desk = cv.Desk(Path(tempfile.mkdtemp(prefix="d1bench-")), env=env, http_=http, log=lambda *a, **k: None)
    desk.warm_keys()
    s = desk.settings()
    card = desk.cards.build("holocene-pm")
    for i in range(n):
        for k in keys:
            http.last.clear()
            t0 = time.time()
            raw = desk.decide(s, agent="holocene-pm", name="Holocene PM", transcript=PROMPTS[k], sess=None, card=card)
            llm = raw.get("llm") or {}
            print(json.dumps({"variant": sys.argv[1], "i": i, "prompt": k, "path": raw["path"], "wall_ms": int((time.time() - t0) * 1000),
                              "action": raw["decision"].get("action"), "say_chars": len(raw["decision"].get("say") or ""),
                              "say": (raw["decision"].get("say") or "")[:160],
                              "attempts": llm.get("attempts"), "calls": http.last[:]}, default=str), flush=True)
            time.sleep(1.0)


if __name__ == "__main__":
    main()
