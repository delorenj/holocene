# Converse ladder bench (MVP step 1), 2026-10-22

Setup: 20 non-streamed calls per rung plus 8 streamed calls for first token, ~750-token realistic system prompt
(agent card, roster, delegation board, 3-turn window; 20 varied driver utterances), `response_format: json_object`,
`max_tokens` 700, one warm-up call per rung, keep-alive off. Key refs: Hyper = `op://DeLoSecrets/tflaecgcrdgxrh2ovgi5ysjkzq/credential`
(shared with Hindsight), gateway = `op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/holocene-converse`.
Run from big-chungus to the public endpoints. "JSON ok" = parses AND has `say` and `action`.

| Rung | Route | Whole-JSON p50 | p90 | min / max | First token p50 / p90 | JSON ok | `model` field returned | Notes |
|---|---|---|---|---|---|---|---|---|
| r1 | hyper `deepseek-v4.1-flash-1017` | **0.94 s** | 1.41 s | 0.69 / 1.79 | 0.62 / 1.16 s | 20/20 (format example in prompt) | `deepseek-v4.1-flash-1017` | prefix cached (640 of 756 tokens) |
| r1 (prompt A) | same, prompt WITHOUT an explicit output example | 1.00 s | 1.44 s | 0.60 / 2.27 | 0.76 / 1.02 s | **12/20** | same | see finding 1 |
| r2 | hyper `deepseek-v4.1-flash` | 2.50 s | 4.74 s | 1.21 / 6.13 | 2.83 / 3.72 s | 20/20 | `deepseek-v4.1-flash` | no prefix cache reported |
| r3a | gateway `automaticai/personal/kimi-k3s`, default effort | 11.41 s | 15.63 s | 2.91 / 18.94 | 10.01 / 12.50 s | 20/20 | `k3-256k` | temperature must be 1 |
| r3a-med | same, `reasoning_effort=medium` | **4.05 s** | 11.08 s | 2.75 / 16.59 | 4.96 / 12.99 s | 20/20 | `k3-256k` | best gateway rung, fat tail |
| r3b | gateway `automaticai/personal/glm-5.3-flash`, default (max) | 7.70 s | 11.97 s | 2.55 / 21.54 | 6.20 / 10.08 s | 18/20 | `glm-5.3-flash` | |
| r3b-med | same, `reasoning_effort=medium` | 8.11 s | 13.82 s | 2.48 / 21.02 | 8.19 / 13.40 s | 18/20 | `glm-5.3-flash` | medium does not help |

`reasoning_effort=low` is **rejected** by the gateway on both routes: `400 effort must be medium, high, xhigh or max`.
Medium is the floor. Neither the gateway `model` field nor any rung ever returned a Claude/Anthropic/auto model.

## Findings

1. **`json_object` alone is not enough on -1017.** With a prompt that only says "return one JSON object", 8 of 20 replies came back as
   plain prose (finish_reason stop, no JSON) while the request carried `response_format: json_object`. Adding an OUTPUT FORMAT block with two literal
   example objects (reply and propose) in the system prompt made it 20/20. The converse prompt MUST include literal example objects, and
   `parse_decision` must still treat unparseable text as `action=reply` with the text as `say`.
2. **kimi-k3s only accepts temperature 1** (`400 invalid temperature: only 1 is allowed for this model`). The converse client must send
   temperature 1 (or omit it) on kimi rungs; 0.3 only on Hyper/GLM.
3. **The gateway rungs are slow.** Even the best (kimi medium) is 4 s p50 and 11 s p90; GLM is 7.7-8.1 s p50. With `MEMO_CONVERSE_BUDGET_S=8`
   and a 5 s r3 timeout, r3 will often not finish. It is an availability fallback only. Keep the per-rung timeouts above the p50, or accept that r3
   rescues about half of the turns that reach it.
4. r2 (base flash) is 2.7x slower than r1 at p50, as the plan measured; it only covers a retired snapshot.
5. Gateway tokens do not return the requested model name; kimi answers `k3-256k`. The FORBIDDEN_MODEL_RE check on the response `model` is still sound
   (it only needs to reject claude/anthropic/auto names), but do not assert equality with the route id.

## Decision: r3 order

1. r3a `automaticai/personal/kimi-k3s` with `reasoning_effort=medium`, `temperature=1`, timeout 5 s (p50 4.05 s).
2. r3b `automaticai/personal/glm-5.3-flash` with `reasoning_effort=medium` (low is refused), timeout 5 s.

## Token

`holocene-converse` (gateway token id 88, group aai-personal, 90 days, expiry 2027-01-19), scope read back from the gateway is exactly
`automaticai/personal/glm-5.3-flash,automaticai/personal/kimi-k3s`. No claude, no auto. Vault item "AutomaticAI Gateway Tokens", field
`holocene-converse`: `op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/holocene-converse`. `op read` of both refs succeeds from a `systemd-run --user` shell.

## Blocker ticket

AAI-53 on the client-portal board: hypercharm gateway channel + `automaticai/hypercharm/deepseek-v4.1-flash-1017` route scoped to
`holocene-converse` (cut over when it adds < 250 ms p50 over the direct 0.94 s), plus a request for a dedicated Hyper key because rungs 1/2 use the
Hindsight-shared key (`tflaecgcrdgxrh2ovgi5ysjkzq`, about 333 hypercredits left).
