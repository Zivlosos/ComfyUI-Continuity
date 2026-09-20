"""What Qwen Image 2.1 is, before anything of Qwen Image 2.1's is imported.

See `families/h3/declare.py` for why this is its own module.
"""

ID = "qwen21"
LABEL = "Qwen Image 2.1"

ORDER = 6

# Still only. There is no duration, no frame grid and no seam, which is why
# `RULES` is None: a family with nothing to snap a frame count to has no canvas
# arithmetic to declare, and `registry.rules` says so by not having an entry.
PRODUCES = frozenset({"still"})
RULES = None

# What this family's stills are called under `continuity/stills/qwen21/`. See
# `h3/declare.py` for why the stem is declared rather than derived.
OUTPUT_STEM = "Qwen21"

# The pre-stage arch pill's own id for it, which is the family id: unlike H3's
# "minimax" there was never an earlier spelling to stay compatible with.
STILL_ARCH = "qwen21"

PROMPT_PIPELINE = "plain"
LORA_STACK = "core"
DURATION_HEAD = None
ROUTED = ()
