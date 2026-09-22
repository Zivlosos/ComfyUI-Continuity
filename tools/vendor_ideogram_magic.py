#!/usr/bin/env python3
"""Vendor Ideogram 4's open-source magic-prompt system prompt into the pack.

Upstream — <https://github.com/ideogram-oss/ideogram4>, Apache-2.0 for the code
(the weights are under a licence of their own, and none of them is copied) —
ships the instruction it hands an LLM to turn a plain idea into the JSON
caption the model was trained on, as `magic_prompt_system_prompts/v1.txt`.
Only that file is taken, with the licence beside it; the Python around it is a
client for hosted endpoints, and what this pack needs of it — the key order,
the stripping of `aspect_ratio` and the bboxes — is ported by hand in
`creator/families/ideogram4/magic.py`, where it is tested.

The file is copied byte for byte and never edited here. What the pack has to
say on top of it (the `{a|b}` groups, the aspect the render is drawn at) goes
into the user turn `magic.py` builds, so a re-sync is a copy and nothing more.

Re-syncing:

    git clone https://github.com/ideogram-oss/ideogram4 /tmp/ideogram4
    python3 tools/vendor_ideogram_magic.py /tmp/ideogram4
    python3 tests/test_ideogram_magic.py

The upstream commit is written to `REVISION` beside the copy.
"""

import argparse
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "creator", "families", "ideogram4", "magic_prompt")

FILES = {
    os.path.join("src", "ideogram4", "magic_prompt_system_prompts", "v1.txt"): "v1.txt",
    "LICENSE.md": "LICENSE",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("upstream", help="a checkout of ideogram-oss/ideogram4")
    args = parser.parse_args()

    os.makedirs(OUT, exist_ok=True)
    for source, name in FILES.items():
        path = os.path.join(args.upstream, source)
        if not os.path.isfile(path):
            sys.exit(f"{source} is not in {args.upstream} — has upstream moved it?")
        shutil.copyfile(path, os.path.join(OUT, name))
    revision = subprocess.run(["git", "-C", args.upstream, "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    with open(os.path.join(OUT, "REVISION"), "w", encoding="utf-8") as handle:
        handle.write(f"ideogram-oss/ideogram4 {revision}\n")
    print(f"vendored {len(FILES)} files at {revision[:12]} into {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
