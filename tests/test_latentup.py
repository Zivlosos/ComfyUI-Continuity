"""The trained latent upscaler's network, built from a checkpoint's keys.

    COMFYUI_PATH=~/ComfyUI <comfy-venv>/bin/python3 tests/test_latentup.py

Nothing here loads the published file — 691 MB is not a test fixture. What is
held is that the network this pack builds has exactly the parameter layout the
published checkpoint has (`_build` reads the block counts and the temporal
kernel off the keys, and `load_state_dict(strict=True)` is the check), that a
latent comes back at the target size, and that the temporal chunking a long
card goes through lands every frame once.

Skips itself with a message if ComfyUI cannot be imported.
"""

import os
import sys

COMFY = os.environ.get("COMFYUI_PATH", os.path.expanduser("~/ComfyUI"))
sys.path.insert(0, COMFY)

try:
    import torch

    import layout
    latentup = layout.load("latentup").latentup
except Exception as exc:  # noqa: BLE001
    print(f"skipped: ComfyUI not importable ({type(exc).__name__}: {exc})")
    sys.exit(0)

from harness import check, passed

# The published file's shape is 24 channels, 12+12 blocks at 512 wide, kernel 5.
# A miniature with the same layout: the key names are what is under test.
NET = latentup.LatentResizer3D(24, 3, 2, 32, 5)
NET.eval()

# ---- the checkpoint layout ---------------------------------------------------

sd = NET.state_dict()
keys = sorted(sd)
check("in_blocks carry a temporal conv after every second block",
      [k for k in keys if k.startswith("in_blocks.") and k.endswith("dwconv.weight")],
      ["in_blocks.1.dwconv.weight", "in_blocks.4.dwconv.weight"])
check("the modulated ResBlock keys are upstream's",
      [k for k in keys if k.startswith("in_blocks.0.")],
      ["in_blocks.0.emb_layers.1.bias", "in_blocks.0.emb_layers.1.weight",
       "in_blocks.0.in_layers.0.bias", "in_blocks.0.in_layers.0.weight",
       "in_blocks.0.in_layers.2.bias", "in_blocks.0.in_layers.2.weight",
       "in_blocks.0.out_layers.2.bias", "in_blocks.0.out_layers.2.weight",
       "in_blocks.0.out_norm.bias", "in_blocks.0.out_norm.weight"])

rebuilt = latentup._build(sd)
rebuilt.load_state_dict(sd, strict=True)
check("_build reads the block counts and kernel back off the keys",
      (len([b for b in rebuilt.in_blocks if isinstance(b, latentup.ResBlock)]),
       len([b for b in rebuilt.out_blocks if isinstance(b, latentup.ResBlock)]),
       rebuilt.temporal_kernel),
      (3, 2, 5))

# ---- the forward ---------------------------------------------------------------

torch.manual_seed(0)
short = torch.randn(1, 24, 6, 4, 6)
with torch.inference_mode():
    out = NET(short, 1.5, 6, 9)
check("a clip under the window comes back at the target size", tuple(out.shape), (1, 24, 6, 6, 9))
check("and finite", bool(torch.isfinite(out).all()), True)

# Over the window: 40 frames against a 32-frame chunk with a 5-frame halo.
# Not equal to a single pass, and not meant to be: GroupNorm takes its
# statistics over the whole window it is handed, and the chunked road pads the
# clip's ends by replication where a single pass has the convs' zeros. What is
# held is that the blend lands every frame once — a frame counted twice or not
# at all would be off by the whole signal, not by a normalization's worth.
long = torch.randn(1, 24, 40, 4, 6)
with torch.inference_mode():
    chunked = NET(long, 2.0, 8, 12)
    whole = NET._segment(long, 2.0, (40, 8, 12))
check("a clip over the window comes back at the target size", tuple(chunked.shape), (1, 24, 40, 8, 12))
interior = (chunked - whole)[:, :, 8:32].abs().mean() / whole.abs().mean()
check("the interior of a chunked clip is a single pass within a normalization",
      bool(interior < 0.1), True)

# ---- the node's road -------------------------------------------------------------

# `upscale` refuses to draw down: the refine target is always over the first
# pass, and a net trained on 1x–4x has nothing to say under 1.
latentup._LOADED["tiny"] = type("P", (), {"model": NET, "load_device": "cpu"})()
was = latentup.comfy.model_management.load_models_gpu
latentup.comfy.model_management.load_models_gpu = lambda *a, **k: None
try:
    try:
        latentup.upscale(torch.randn(1, 24, 2, 8, 8), 64, 64, "tiny")
        check("a target under the first pass is refused", "raised", "did not raise")
    except ValueError as exc:
        check("a target under the first pass is refused", "draws up" in str(exc), True)
    with torch.inference_mode():
        video = torch.randn(1, 24, 2, 4, 6)
        drawn = latentup.upscale(video, 96 * 2, 64 * 2, "tiny")
    check("upscale hands back the caller's shape and dtype",
          (tuple(drawn.shape), drawn.dtype), ((1, 24, 2, 8, 12), video.dtype))
finally:
    latentup.comfy.model_management.load_models_gpu = was
    latentup._LOADED.pop("tiny", None)

passed("all latent upscaler tests passed")
