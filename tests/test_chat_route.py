"""The chat render route builds over the node on the canvas.

    COMFYUI_PATH=~/ComfyUI <comfy-venv>/bin/python3 tests/test_chat_route.py

`tests/test_chat.py` pins the pure half — what a turn's action becomes over a
base blob. This is the route's half, which needs the node classes: that the
base the room sends is read and refused as it should be, that the node's own
widget values ride into the prompt over the family's defaults, and that a
render built for a clip carries the piece's sampler row, stack and turbo
switch rather than anything re-derived here. Nothing is queued and no model
folder has to hold a file: the listing and the machine's picks are stood in.

Skips itself with a message if ComfyUI cannot be imported.
"""

import asyncio
import importlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE = os.path.basename(ROOT)

COMFY = os.environ.get("COMFYUI_PATH", os.path.expanduser("~/ComfyUI"))
BASE = os.environ.get("COMFYUI_BASE", COMFY)


def _boot():
    sys.path.insert(0, COMFY)
    sys.argv = ["main.py", "--base-directory", BASE]
    import nodes
    import server

    loop = asyncio.new_event_loop()
    server.PromptServer(loop)
    asyncio.set_event_loop(loop)
    loop.run_until_complete(nodes.init_extra_nodes(init_custom_nodes=False))

    sys.path.insert(0, os.path.dirname(ROOT))
    return nodes


try:
    _boot()
except Exception as exc:  # noqa: BLE001
    print(f"skipped: ComfyUI not importable ({type(exc).__name__}: {exc})")
    sys.exit(0)

importlib.import_module(PACKAGE)
route = importlib.import_module(f"{PACKAGE}.creator.routes.chat")
chat = importlib.import_module(f"{PACKAGE}.creator.chat")
core_models = importlib.import_module(f"{PACKAGE}.creator.models")

from harness import FAILURES, check, passed


def refuses(label, call, *fragments):
    try:
        call()
    except chat.ActionError as problem:
        for fragment in fragments:
            if fragment not in str(problem):
                FAILURES.append(f"{label}: {str(problem)!r} does not mention {fragment!r}")
    else:
        FAILURES.append(f"{label}: did not refuse")


# ---- the base --------------------------------------------------------------

PIECE = {"version": 2, "prompt": "", "family": "h3", "models": {},
         "loras": [{"name": "h3_lightx2v.safetensors", "strength": 0.6, "enabled": True}],
         "turbo": {"on": True, "lora": "h3_lightx2v.safetensors"},
         "sampling": {"steps": 6, "cfg": 1.0, "sampler_name": "euler", "scheduler": "beta"},
         "segments": [{"prompt": "one"}, {"prompt": "two"}]}
PRE = {"version": 1, "arch": "krea2", "prompt": "", "init": None, "refs": [],
       "loras": [], "turbo": {}, "models": {"krea2": {}, "dtype": "default"},
       "sampling": {"steps": 8, "cfg": 1.0}}

check("a piece is read as sent", route._base({"piece": PIECE, "widgets": {"seed": 7}}, False),
      (PIECE, {"seed": 7}))
check("and a blob still as a string is parsed",
      route._base({"piece": json.dumps(PRE)}, True), (PRE, {}))
refuses("no base is refused, not defaulted", lambda: route._base(None, False), "no node")
refuses("a still over a piece is refused", lambda: route._base({"piece": PIECE}, True), "not a pre-stage")
refuses("a clip over a pre-stage is refused", lambda: route._base({"piece": PRE}, False), "not a piece")

check("the rail names the piece's family", route._families_of(PIECE, False), {"video_family": "h3"})
check("and the pre-stage's arch as its family", route._families_of(PRE, True), {"still_family": "krea2"})
refuses("a pre-stage on the H3 branch cannot draw the room's picture",
        lambda: route._families_of({**PRE, "arch": "minimax"}, True), "MiniMax H3", "image model")

# ---- the widgets ------------------------------------------------------------

node = route._nodes()["MiniMaxH3Creator"]
family = route.manifest.describe("h3")
defaults = route._node_widgets(node, family, {})
own = route._node_widgets(node, family, {"seed": 42, "steps": 6, "sampler_name": "euler",
                                          "control_after_generate": "fixed", "nonsense": 1,
                                          "cfg": ["not", "a", "number"]})
check("the node's own values ride over the family's",
      (own["seed"], own["steps"], own["sampler_name"]), (42, 6, "euler"))
check("a name the schema does not declare is dropped",
      ("nonsense" in own, "control_after_generate" in own), (False, False))
check("and a value of the wrong shape leaves the default standing", own["cfg"], defaults["cfg"])
check("nothing else moved", {k: v for k, v in own.items() if k not in ("seed", "steps", "sampler_name")},
      {k: v for k, v in defaults.items() if k not in ("seed", "steps", "sampler_name")})

# ---- the build, over a machine with every file --------------------------------

FILES = {
    "diffusion_models": ["h3_fl2va.safetensors", "h3_ref2va.safetensors"],
    "text_encoders": ["qwen3.safetensors"], "vae": ["video_vae.safetensors", "audio_vae.safetensors"],
    "loras": ["h3_lightx2v.safetensors"],
}
STORED = {"h3": {"fl2va": "h3_fl2va.safetensors", "ref2va": "h3_ref2va.safetensors",
                 "clip": "qwen3.safetensors", "vae": "video_vae.safetensors",
                 "audio_vae": "audio_vae.safetensors"}}
_real_available = core_models.available
core_models.available = lambda: {"by_folder": FILES, "files": {}, "installed": {}}
try:
    action = chat.validate({"act": "render", "kind": "video", "prompt": "a fox", "seconds": 4}, [])
    rail = route._rail({"aspect": "16:9", "video_edge": 768, "video_family": "h3"})
    built = route._build(action, [], rail, STORED, (PIECE, {"seed": 42, "steps": 20}))
finally:
    core_models.available = _real_available

if "problem" in built:
    FAILURES.append(f"the build over a full machine was refused: {built['problem']}")
else:
    inputs = built["prompt"]["1"]["inputs"]
    blob = json.loads(inputs["creator_data"])
    check("the render is a one-node prompt for the Creator", built["prompt"]["1"]["class_type"], "MiniMaxH3Creator")
    check("the seed is the node's widget", inputs["seed"], 42)
    check("the blob carries the piece's row, stack and switch",
          (blob["sampling"], blob["loras"], blob["turbo"]),
          (PIECE["sampling"], PIECE["loras"], PIECE["turbo"]))
    check("the strip became one card with the turn's prompt",
          [card["prompt"] for card in blob["segments"]], ["a fox"])
    check("the machine's picks filled the piece's empty weights",
          blob["models"]["fl2va"], "h3_fl2va.safetensors")
    check("and the piece handed back is the one queued", built["piece"], blob)

passed("the chat render route builds over the node on the canvas")
