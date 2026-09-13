"""A prompt of only whitespace is no prompt.

    python3 tests/test_blank_prompt.py

The compiler strips it to nothing, and the box's placeholder hangs off the box
being empty — so every parser reads blank as "", including the "\\n" a box
cleared to the browser's own <br> used to serialize as. Runs the real state
and prompt modules over the DOM shim. No server.
"""

import layout
from domshim import DOM
from harness import check

layout.skip_without_node()

SCRIPT = r'''
globalThis.app = { extensionManager: { setting: { get: () => "en" } } };
const S = await import("./web/creator/state.js");
const { PromptBox } = await import("./web/creator/prompt.js");
const out = {};

// Every parser, on every shape a saved blank arrives in.
out.parsed = {};
for (const [name, blank] of [["newline", "\n"], ["spaces", "  "], ["mixed", " \n\t"], ["empty", ""]]) {
  out.parsed[name] = [
    S.parseState(JSON.stringify({ prompt: blank })).prompt,
    S.parseTimeline(JSON.stringify({ version: 2, prompt: blank, segments: [] })).prompt,
    S.parseTimeline(JSON.stringify({ version: 2, segments: [{ prompt: blank }] })).segments[0].prompt,
    S.parsePreStage(JSON.stringify({ prompt: blank })).prompt,
  ];
}
out.kept = S.parseState(JSON.stringify({ prompt: " a room\n" })).prompt;

// The box: cleared to the browser's <br>, it reads as nothing and holds nothing.
{
  const state = { prompt: "abc", assets: [] };
  const box = new PromptBox({
    getState: () => state, onInput: (text) => { state.prompt = text; },
    onAttach: () => null, attachBlocked: () => null,
  });
  document.body.appendChild(box.root);
  box.setValue("abc");
  box.root.replaceChildren(document.createElement("br"));
  box.onEdit();
  out.cleared = { value: box.getValue(), children: box.root.childNodes.length, state: state.prompt };
  // A <br> the engine leaves after a trailing newline stands for nothing either.
  box.root.replaceChildren(document.createTextNode("one\n"), document.createElement("br"));
  out.trailing = box.getValue();
  box.root.replaceChildren(document.createTextNode("one"), document.createElement("br"), document.createTextNode("two"));
  out.between = box.getValue();
}
console.log(JSON.stringify(out));
'''

with layout.pack(skip=["atlas"]) as target:
    result = layout.in_pack(DOM + SCRIPT, target)

for name, got in result["parsed"].items():
    check(f"a saved {name} prompt reads as empty in every parser", got, ["", "", "", ""])
check("a real prompt is kept as typed", result["kept"], " a room\n")
check("a box cleared to the browser's <br> holds nothing",
      result["cleared"], {"value": "", "children": 0, "state": ""})
check("a <br> after a trailing newline is not a second line", result["trailing"], "one\n")
check("...but one between two lines is the line break it is", result["between"], "one\ntwo")
