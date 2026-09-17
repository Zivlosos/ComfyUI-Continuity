"""Does a VAE file's own header say which model's VAE it is?

Runs standalone — `python tests/test_vaekind.py` — with no torch and no
ComfyUI, which is the property `vaekind.py` is written to keep.

The headers built here carry the detection keys `comfy/sd.py` switches on,
so a change to which key names a kind here has to be a change core made
first. And the same three-valued rule as `visionweights`: a file the table
does not know is `None`, and `None` is never a refusal — the one thing this
check must not do is ground a render over a VAE it merely has not met.
"""

import json
import os
import struct
import tempfile

import layout

from harness import FAILURES, check

vaekind = layout.load("vaekind").vaekind

WORK = tempfile.mkdtemp(prefix="mmc-vaekind-")


def path(name):
    return os.path.join(WORK, name)


def safetensors(name, tensors):
    """`tensors` is `{key: shape}`; a real header with no data behind it."""
    header = {key: {"dtype": "F16", "shape": shape, "data_offsets": [0, 2]}
              for key, shape in tensors.items()}
    header["__metadata__"] = {"format": "pt"}
    blob = json.dumps(header).encode()
    with open(path(name), "wb") as handle:
        handle.write(struct.pack("<Q", len(blob)))
        handle.write(blob)
    return path(name)


FLUX2 = {"bn.running_mean": [128], "decoder.conv_in.weight": [512, 32, 3, 3]}
QWEN = {"decoder.middle.0.residual.0.gamma": [384],
        "decoder.head.2.weight": [3, 96, 3, 3, 3]}
WAN22 = {**QWEN, "decoder.upsamples.0.upsamples.0.residual.2.weight": [384, 384, 3, 3, 3]}
H3_VIDEO = {"decoder.transformer_blocks.0.scale1": [1],
            "encoder.down.5.block.0.conv1.weight": [512, 512, 3, 3, 3]}
H3_AUDIO = {"pre_block.attn.zero_k_bias": [1024]}
LTX_DIFF = {"decoder.conv_in_x_t.weight": [1024, 128, 3, 3, 3],
            "decoder.conv_in.weight": [1024, 128, 3, 3, 3]}
LTX_CONV = {"decoder.up_blocks.0.res_blocks.0.conv1.conv.weight": [1024, 1024, 3, 3, 3]}
LTX_AUDIO = {"vocoder.resblocks.0.convs1.0.weight": [512, 512, 3]}
SD = {"decoder.conv_in.weight": [512, 4, 3, 3]}
FLUX1 = {"decoder.conv_in.weight": [512, 16, 3, 3]}

for label, tensors, want in (
    ("the Flux 2 VAE", FLUX2, "flux2"),
    ("the Qwen image (Wan 2.1) VAE", QWEN, "qwen_image"),
    ("the Wan 2.2 VAE, which shares Qwen's layout at 48 channels", WAN22, "wan22"),
    ("the H3 video VAE", H3_VIDEO, "h3_video"),
    ("the H3 audio VAE", H3_AUDIO, "h3_audio"),
    ("LTX's diffusion decoder", LTX_DIFF, "ltx_video"),
    ("LTX's '-conv-' decoder", LTX_CONV, "ltx_video"),
    ("LTX's audio VAE", LTX_AUDIO, "ltx_audio"),
    ("an SD VAE", SD, "sd"),
    ("a Flux 1 VAE", FLUX1, "flux1"),
):
    check(label, vaekind.identify(safetensors(want + ".safetensors", tensors)), want)

# LTX's diffusion decoder also spells `decoder.conv_in.weight` at 128 wide, and
# must not fall through to the width-only rows.
check("LTX's diffusion decoder is not read as a plain AutoencoderKL",
      vaekind.identify(safetensors("ltx2.safetensors",
                                   {"decoder.conv_in.weight": [1024, 128, 3, 3, 3],
                                    "decoder.conv_in_x_t.weight": [1, 1]})),
      "ltx_video")

# ---- what the file did not say -----------------------------------------------

check("a missing file", vaekind.identify(path("nope.safetensors")), None)
check("a pickle is not read", vaekind.identify(safetensors("vae.pt", FLUX2)), None)
check("a VAE the table has not met",
      vaekind.identify(safetensors("taesd.safetensors", {"taesd_decoder.1.weight": [64, 4, 3, 3]})),
      None)
with open(path("short.safetensors"), "wb") as handle:
    handle.write(struct.pack("<Q", 10 ** 9))
check("an implausible header length", vaekind.identify(path("short.safetensors")), None)

# ---- the refusal -------------------------------------------------------------

def refused(file, wanted):
    try:
        vaekind.check(file, wanted, os.path.basename(file))
    except ValueError as err:
        return str(err)
    return None

flux2 = safetensors("flux2-vae.safetensors", FLUX2)
qwen = safetensors("qwen_image_vae.safetensors", QWEN)
sentence = refused(flux2, "qwen_image")
check("issue #94: the Flux 2 VAE on a Krea 2 render is refused by name",
      sentence is not None and "flux2-vae.safetensors is the Flux 2 VAE" in sentence
      and "the Qwen image VAE" in sentence, True)
check("the right file passes", refused(qwen, "qwen_image"), None)
check("an unknown file passes — the loader downstream gets to complain",
      refused(path("nope.safetensors"), "qwen_image"), None)
check("Wan 2.2 is not Qwen's VAE, though it shares the layout",
      "Wan 2.2" in (refused(safetensors("wan22.safetensors", WAN22), "qwen_image") or ""),
      True)
