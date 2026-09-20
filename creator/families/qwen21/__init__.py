"""Qwen Image 2.1: Alibaba's second-generation Qwen-Image DiT, one checkpoint
that draws from prose and edits from pictures, behind a Qwen3-VL-8B encoder
that reads the pictures as well as the sentence.

A still-only family, and a different animal from Qwen Image Edit despite the
name: a new DiT (`comfy/ldm/qwen_image21`), a new 64-channel RGBA VAE, the
Ideogram-sized Qwen3-VL encoder rather than the 2.5-VL 7B, a schedule core
detects on its own, and an encoder node that splices each reference into the
sequence as latents at the place its `<imageN>` token stood. Nothing of the
2509/2511 recipe survives — no AuraFlow shift, no CFG-norm, no edition pill —
which is why this is its own package rather than an edition of that one. The
rest of the flow is the shared image-still layer in `compile_image.py` /
`render_image.py`, which every image family rides.

No imports here, for the reason `families/__init__.py` gives.
"""
