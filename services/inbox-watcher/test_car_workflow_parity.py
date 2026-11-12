"""Prompt-only regressions: extract constants/functions via AST, never import the service."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


HERE = Path(__file__).resolve().parent
PREFIXES = (
    ("inbox_watcher.py", "VOICE_PREFIX", "MEMO_VOICE_PREFIX"),
    ("inbox_watcher.py", "FOLLOWUP_PREFIX", "MEMO_FOLLOWUP_PREFIX"),
    ("converse.py", "DELEGATE_PREFIX", "MEMO_CONVERSE_DELEGATE_PREFIX"),
)


def extract(filename, name, env=None):
    tree = ast.parse((HERE / filename).read_text(), filename=filename)
    node, = [n for n in tree.body if (
        isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)
    ) or (isinstance(n, ast.FunctionDef) and n.name == name)]
    scope = {"os": SimpleNamespace(environ=env if env is not None else {})}
    exec(compile(ast.Module(body=[node], type_ignores=[]), filename, "exec"), scope)
    return scope[name]


def assert_role_workflow(case, prompt):
    for required in (
        "Follow your normal role workflow",
        "PMs delegate implementation",
        "use coding workers when implementation requires them",
        "Being in the car does not reduce authorization to edit or test code",
        "does not bypass role boundaries or permission limits",
    ):
        case.assertIn(required, prompt)
    for obsolete in ("never delegate", "no delegate_task", "do it yourself"):
        case.assertNotIn(obsolete, prompt.lower())


class CarWorkflowPrefixes(unittest.TestCase):
    def test_all_three_defaults_preserve_role_and_coding_authorization(self):
        for filename, name, _ in PREFIXES:
            with self.subTest(prefix=name):
                assert_role_workflow(self, extract(filename, name))

    def test_environment_overrides_still_win_including_empty_override(self):
        for filename, name, env_key in PREFIXES:
            for override in ("custom transport prefix ", ""):
                with self.subTest(prefix=name, override=override):
                    self.assertEqual(extract(filename, name, {env_key: override}), override)

    def test_immediate_turn_keeps_latency_background_and_audio_rules(self):
        prompt = extract("inbox_watcher.py", "VOICE_PREFIX")
        for required in (
            "speech-to-text, may contain recognition errors",
            "A driver is waiting",
            "within about a minute and at most 3 tool calls",
            "before each tool call, write one short sentence",
            "Never run vox-speak or any text-to-speech yourself",
            "never sleep or wait and re-check",
            "run no deploy or long command unless asked",
            "do not start it now",
            "BACKGROUND: followed by complete instructions for the background turn",
            "result is spoken to the driver as a follow-up",
        ):
            self.assertIn(required, prompt)

    def test_background_and_confirmed_turns_keep_spoken_summary_and_no_tts(self):
        for filename, name, _ in PREFIXES[1:]:
            with self.subTest(prefix=name):
                prompt = extract(filename, name)
                for required in (
                    "Never run vox-speak or any text-to-speech yourself",
                    "speech-to-text",
                    "do only the read-only part and say what you left undone",
                    "Run no deploy, restart, push or other change to a live system unless",
                    "spoken summary of the result in two to four sentences",
                    "do not write a BACKGROUND: line",
                ):
                    self.assertIn(required, prompt)
        self.assertIn("one-minute budget does not apply here",
                      extract("inbox_watcher.py", "FOLLOWUP_PREFIX"))

    def test_permission_authorities_remain_distinct(self):
        self.assertIn("unless the driver's own words asked for it",
                      extract("inbox_watcher.py", "FOLLOWUP_PREFIX"))
        self.assertIn("unless the Permission section below allows it",
                      extract("converse.py", "DELEGATE_PREFIX"))

    def test_rendered_confirmed_brief_retains_exact_body_words_and_permission(self):
        render = extract("converse.py", "render_prompt")
        render.__globals__["DELEGATE_PREFIX"] = extract("converse.py", "DELEGATE_PREFIX")
        rules = extract("converse.py", "PERM_RULE")
        for perm, rule in rules.items():
            with self.subTest(permission=perm):
                body = f"# Fix car workflow\n\nKeep role boundaries.\n\n## Permission\n{rule}"
                draft = {"body": body, "brief_id": "brief-27", "perm": perm}
                words = [("10:00:01", "Fix the workflow, don't change the voice."), ("10:00:20", "Send it.")]
                prompt = render(draft, words, "conv-27", "memo-27", "holocene-pm")
                expected = (
                    render.__globals__["DELEGATE_PREFIX"] + body
                    + '\n\n## The driver\'s own words (speech-to-text, oldest first)\n'
                    + '- 10:00:01 "Fix the workflow, don\'t change the voice."\n- 10:00:20 "Send it."'
                    + "\n\n## Trace\nconversation conv-27 · memo memo-27 · brief brief-27 · asked via holocene-pm"
                )
                self.assertEqual(prompt, expected)
                assert_role_workflow(self, prompt)


if __name__ == "__main__":
    unittest.main()
