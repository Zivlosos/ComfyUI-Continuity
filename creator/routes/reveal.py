"""The picker's Open folder: the OS's own file manager on one of its shelves (#23)."""

import os
import subprocess

from aiohttp import web
from server import PromptServer

import folder_paths

from .. import assets
from ..guard import same_origin


@PromptServer.instance.routes.post("/continuity/reveal")
@same_origin
async def reveal_folder(request):
    """Open a folder the picker browses in the operating system's file manager.

    On the machine ComfyUI runs on — which is the only machine this process
    can open anything on, and is not always the one the browser is on. So the
    answer carries the path either way: on a local install the window comes up
    and the path is a caption; on a remote one nothing comes up, the reply
    says so, and the path is the thing you actually wanted (#23).

    The output directory is asked of `folder_paths` rather than assumed, so an
    install started with `--output-directory` opens the folder it writes to.
    """
    body = await request.json()
    root = assets.picker_root(body.get("root"))
    if root is None:
        return web.json_response({"error": "not a folder the picker browses"}, status=400)
    subfolder = assets.clean_subfolder(body.get("subfolder", ""))
    if subfolder is None:
        return web.json_response({"error": "bad folder name"}, status=400)
    target = os.path.realpath(os.path.join(root, subfolder)) if subfolder else root
    if not folder_paths.is_within_directory(root, target) or not os.path.isdir(target):
        return web.json_response({"error": "no such folder"}, status=404)
    try:
        # Detached, and not waited for: `open` and `explorer` return at once,
        # `xdg-open` returns when the file manager has taken the folder.
        subprocess.Popen(assets.reveal_command(target), stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as exc:
        # No file manager to hand it to — a headless box, a container. The
        # path is still the answer.
        return web.json_response({"error": f"this machine has no file manager to open it in ({exc})",
                                  "path": target}, status=501)
    return web.json_response({"path": target})
