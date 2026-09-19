"""What Flux 2 Klein is, before anything of Klein's is imported.

See `families/h3/declare.py` for why this is its own module.
"""

ID = "flux2klein"
LABEL = "Flux 2 Klein"

ORDER = 6

# Still only — see krea2's declaration for what an absent RULES means.
PRODUCES = frozenset({"still"})
RULES = None

# What this family's stills are called under `continuity/stills/flux2klein/`.
OUTPUT_STEM = "Flux2Klein"

# The pre-stage arch pill's own id for it, which is the family id: no earlier
# spelling to stay compatible with.
STILL_ARCH = "flux2klein"

PROMPT_PIPELINE = "plain"
LORA_STACK = "core"
DURATION_HEAD = None
ROUTED = ()

# Saved references (`creator/refmod.py`). Klein reads a reference as a Flux 2
# VAE latent chained onto the conditioning, and that VAE packs a 2x2 into its
# channels: a 1 MP picture is a 64x64 grid and every cell is a token, so a
# full mod is 4,096 of them. Compressed pools the grid to 32 on its long edge
# — a quarter of the tokens; unmeasured against the picture, which is what the
# lab run after this lands is for. Stills only: the family draws no clips.
REFMOD = {"space": "flux2", "megapixels": 1.0, "grid": 32, "clips": False}
