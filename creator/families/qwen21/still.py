"""Qwen Image 2.1's own half of an image render: the constants and the
sampler branch.

The shared flow — prompt, triggers, references, the /16 canvas — is
`compile_image.compile_prestage` and `render_image.emit`, which take this
module as the `family` and read the declarations below. What stays here is
what only this architecture knows: one encoder node that reads the sentence
and every attached picture together and hands back both conditionings, the
`<imageN>` spelling its tokenizer writes in front of each picture, the pixel
budget the references are resized to, and the fact that the first picture is
also the one being edited.

Everything it emits is core's, taken from the official ComfyUI Qwen Image 2.1
templates (`image_qwen_image_2_1_t2i`, `_image_edit`) rather than invented.
Compared with the Qwen Image Edit family this is a shorter graph, not a
variant of the same one: the schedule is detected (`supported_models.
QwenImage21` carries the shift, so no `ModelSamplingAuraFlow`), the templates
sample at cfg 1 with no `CFGNorm`, and drawing from nothing and editing a
picture go through the same encoder node — its template is the text-to-image
one with the references prepended, so there is no system prompt about a
picture that is not there and nothing to switch encoders over.
"""

import math
import sys

ARCH = "qwen21"

# Which weights fields this architecture has. One DiT: the speed axis is a
# Lightning LoRA or nothing, so there is nothing to route between.
FIELDS = ("model", "clip", "vae")

# Which VAE the `vae` field has to hold, checked off the file's header before
# the render is queued — see `vaekind`. Not the Qwen image VAE: 2.1 ships its
# own, 64 latent channels at /16 with an alpha channel in and out, and the
# 16-channel one Qwen Image Edit and Krea 2 decode with would sample the whole
# render before core's decode found the mismatch.
VAE_KIND = "qwen_image21"

# What CLIPLoader calls the encoder. The same type string Qwen Image Edit
# loads its 2.5-VL through — core tells the two apart by what is in the file,
# and a Qwen3-VL-8B under `qwen_image` is what routes to the 2.1 tokenizer.
CLIP_TYPE = "qwen_image"

# References are native: `TextEncodeQwenImage21` feeds every attached picture
# to the encoder as vision tokens *and* VAE-encodes it into the conditioning's
# reference latents, and the DiT splices each latent into the sequence where
# its `<imageN>` stood. No adapter to add first — the base weights read them.
TAKES_REFS = True

# What to call them — an edit family's noun. `Picture 1` is the thing the
# instruction is about, read for what is in it, and "style reference" would
# name the one property the model is not being asked about.
REFS_NOUN = ("picture", "pictures")

# ...and how the prompt names them. The 2.1 tokenizer writes `<image1>`,
# `<image2>`, ... in front of each picture's vision block, and the official
# edit prompts cite them by that spelling; `Picture N` is what the *2509/2511*
# encoder writes and means nothing to this one. `compile_image._cite_refs`
# reads this where a family declares it.
REFS_CITATION = "<image{n}>"

# How many. The encoder node grows to sixteen slots; the official template says
# ten and stops there, and so does this pack: every picture is another latent
# the DiT attends over at every step, and ten is already a contact sheet.
REFS_LIMIT = 10
REFS_LIMIT_REASON = ("ten is where the official Qwen Image 2.1 workflow stops — "
                     "every picture is another latent the model attends over "
                     "at every step")

# An edit is a picture being changed, so `Picture 1` also decides the canvas —
# the shared compile promotes it to the init at denoise 1.0 and the render
# comes out its shape. Like Flux 2 Klein and unlike Qwen Image Edit, the
# official graph starts the latent *empty*: the picture reaches the model
# through the reference conditioning, and `emit_graph` honours that by
# emitting the template's own empty latent for a full-denoise init rather
# than an encode about to be noised away. `start_blank` and an explicit init
# win exactly as they do there.
EDITS_FIRST_REF = True

# The references' pixel budget: `TextEncodeQwenImage21` resizes each picture to
# about `resolution`² pixels, aspect kept, at multiples of 32 — the vision
# tower's patch — and the first picture's resized size is the one the edit is
# fitted to. The template's own note is to keep the canvas close to it "or the
# edit can shift", so rather than a widget the budget is *derived* from the
# canvas the shared compile already resolved: the canvas follows the first
# picture's aspect, and the same area at the same aspect is the same size to
# within the two grids' rounding. 0 would keep every reference at its file
# size, which on a phone photo is a 12-megapixel latent the model was never
# asked to attend over.
REF_RESOLUTION_STEP = 32

# What the checkpoint wants from the sampler row with nothing distilled on it.
# Not the shipped template's 25 at cfg 1: a six-way sweep on the lab (2026-09,
# same seed, a candid phone-photo prompt) had that row softest of the set with
# the weakest hands, 40 steps in the range Qwen's own card asks (40-50, euler)
# resolving them, and cfg 3 — a real CFG over the encoder's empty negative —
# the contrast and skin Felix picked over cfg 1's flatter render and cfg 4's
# stock-photo push. The templates say to keep cfg at 1 unless a negative is
# written; the sweep says the guidance is worth having with none.
QWEN21_BASE = {"steps": 40, "cfg": 3.0, "sampler_name": "euler", "scheduler": "simple"}

# The speed axis, and like Qwen Image Edit's it is a LoRA or it is nothing:
# there is no distilled Qwen Image 2.1 checkpoint. The ladder's ends are where
# the Lightning distillations of every Qwen-Image release so far have been
# published, four and eight steps; the middle is for a run that wants a little
# more than the short LoRA's own number.
TURBO_STEPS = {"draft": 4, "medium": 6, "good": 8}
DEFAULT_TURBO_QUALITY = "draft"
TURBO_ROW = {"cfg": 1.0, "sampler_name": "euler", "scheduler": "simple"}
TURBO_NEEDS_LORA = (
    "Qwen Image 2.1 has no distilled checkpoint — its turbo pill is a "
    "Lightning LoRA over the ordinary one. Pick the LoRA, or leave the switch "
    "off and sample the full row"
)


def plan(data):
    """The blob's arch-specific decisions -> (checkpoint field, schedule).

    One checkpoint field either way: the turbo pill here is a LoRA. No schedule
    block — the shift is in core's model detection for these weights, and the
    Lightning LoRAs are fitted against that same schedule.
    """
    from ...compile import CompileError
    from ...compile_image import turbo_block

    turbo = turbo_block(data, ARCH)
    if turbo.get("on") and not turbo.get("lora"):
        raise CompileError(TURBO_NEEDS_LORA)
    return "model", {}


def max_refs(data):
    """`(references this render may carry, why)` — see `REFS_LIMIT`."""
    return REFS_LIMIT, REFS_LIMIT_REASON


def ref_resolution(width, height):
    """The encoder's pixel budget for the canvas — see `REF_RESOLUTION_STEP`."""
    return round(math.sqrt(width * height) / REF_RESOLUTION_STEP) * REF_RESOLUTION_STEP


def require_support():
    """Refuse a core that does not know Qwen Image 2.1 yet — see krea2's twin.

    Keyed off what is registered rather than a version number, and off the
    encoder node rather than the CLIPLoader type: the type string is the one
    Qwen Image Edit has loaded through for a year, and what arrived with 2.1 is
    the node that reads the pictures.
    """
    import nodes

    if "TextEncodeQwenImage21" not in nodes.NODE_CLASS_MAPPINGS:
        raise ValueError(
            "This ComfyUI does not know Qwen Image 2.1 yet (no "
            "TextEncodeQwenImage21 node). Update ComfyUI and restart."
        )


def emit_graph(graph, payload, sampling, weights, clip, vae, model, unique_id,
               filename_prefix):
    """The sampler branch over the shared prologue's loaders."""
    from ... import render_image

    # One encoder node for both kinds of render. With no pictures the `vae`
    # goes unread and the node encodes the sentence on the text-to-image
    # template; with pictures it resizes each to the canvas's budget, reads
    # it through the vision tower and VAE-encodes it into the reference
    # latents — the pair the weights were trained on.
    images = {f"images.image_{i + 1}": render_image.load_picture(graph, payload, f"ref:{i}", name)
              for i, name in enumerate(payload.refs)}
    encoded = graph.node("TextEncodeQwenImage21", clip=clip, prompt=payload.prompt,
                         negative_prompt="", vae=vae,
                         resolution=ref_resolution(payload.width, payload.height),
                         **images)
    # The node encodes the negative whether or not the row will read it —
    # the official graph's own cost, and at cfg 1 the sampler never evaluates
    # it. Wired rather than zeroed so that at a real CFG the unconditional is
    # what the recipe means: the same pictures behind an empty sentence.
    positive, negative = encoded.out(0), encoded.out(1)

    if payload.init is not None and payload.init["denoise"] < 1.0:
        # An explicit init at a partial denoise: the picture encoded, which the
        # 2.1 VAE does as any other, and the leftover noise the row asks for.
        latent, denoise = render_image.emit_latent(graph, payload, vae, "EmptyLatentImage")
    else:
        # Empty at full denoise, *including* the promoted first picture: it
        # already reaches the model as a reference latent, and the official
        # edit template starts from an empty latent for that reason. Core's
        # own `EmptyLatentImage` — it stamps the /8 it was made at, and the
        # sampler rescales an empty latent to the model's /16 and 64 channels,
        # which is how the template itself starts.
        latent = graph.node("EmptyLatentImage", width=payload.width,
                            height=payload.height, batch_size=1).out(0)
        denoise = 1.0

    sampled = graph.node(
        "KSampler", model=model, positive=positive, negative=negative,
        latent_image=latent, seed=sampling.seed, steps=sampling.steps,
        cfg=sampling.cfg, sampler_name=sampling.sampler_name,
        scheduler=sampling.scheduler, denoise=denoise,
    )
    render_image.emit_tail(graph, sampled.out(0), vae, unique_id, filename_prefix,
                           request=payload.neural)


def compile_still(data, image_size_lookup=None):
    """The uniform still surface — see `families/registry.py`. The flow is the
    shared `compile_image.compile_prestage`, handed this module as the family."""
    from ... import compile_image

    return compile_image.compile_prestage(data, sys.modules[__name__],
                                          image_size_lookup)


def emit_still(data, plan, sampling, unique_id):
    """The uniform still surface over the shared `render_image.emit`."""
    from ... import outputs, render_image, settings
    from . import declare

    weights = render_image.ImageWeights.from_blob(data, sys.modules[__name__])
    return render_image.emit(plan, weights, sampling, unique_id,
                             sys.modules[__name__],
                             filename_prefix=outputs.image(
                                 data, settings.image_prefix(declare.ID)))
