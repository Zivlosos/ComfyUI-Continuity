"""The picker's folders and files: the listing walk, the roots it browses, what
one render carries in its own file.

Its own module because it needs core's `folder_paths` and nothing else — no
aiohttp, no PromptServer, no torch — so all of it can be tested with that one
module stubbed, while `server_routes` drags in the whole install.
"""

import json
import os
import sys

import folder_paths


def classify(filename):
    for kind in ("image", "video", "audio"):
        if folder_paths.filter_files_content_types([filename], [kind]):
            return kind
    return None


def scan(root, annotation=""):
    """Walk one media folder -> `(assets, folders)`.

    `annotation` is ComfyUI's ` [output]` suffix.

    The folders come back because the folders *are* the answer: a shelf in the
    picker is a directory on this disk and nothing else, so the listing has to
    report every one of them — including the ones holding no media, which the
    file rows alone can never mention. A shelf that came from anywhere but here
    is a shelf that outlives the directory it named (#40): delete the input
    folder from a terminal and the picker went on offering its contents.

    Carried inside `path` rather than as a separate field because the path is
    the one thing that survives into creator_data: every consumer downstream —
    the thumb and probe routes here, `media.resolve` at execute time — already
    goes through `get_annotated_filepath`, so an annotated path is a file the
    whole pipeline can reach with no second load path.

    Read off `os.scandir`'s entries rather than `os.walk`'s names, because
    enumerating the directory has already answered everything this asks. Going
    back by path — `islink`, `getmtime`, `getsize` — is three more syscalls per
    file, and on Windows that is the entire cost of a listing: `FindFirstFileW`
    hands back the size and the timestamps inline, so `DirEntry.stat()` there is
    free for everything except a symlink, while `os.path.getmtime` on a path
    string is a fresh open through the whole filter driver stack, virus scanner
    included. On Linux and macOS the same change saves two syscalls of three and
    nothing was ever slow enough to notice, which is how a folder of renders
    that lists in a second here listed in minutes on someone's Windows
    server (#4).
    """
    assets = []
    folders = []
    pending = [root]
    index = 0
    while index < len(pending):
        directory = pending[index]
        index += 1
        try:
            with os.scandir(directory) as scan:
                entries = sorted(scan, key=lambda e: e.name)
        except OSError:
            continue
        subfolder = os.path.relpath(directory, root)
        subfolder = "" if subfolder == "." else subfolder.replace(os.sep, "/")
        if subfolder:
            folders.append(subfolder)
        for entry in entries:
            if entry.name.startswith("."):
                continue
            try:
                # follow_symlinks=False is os.walk's own default: a link to a
                # directory is listed, not descended into.
                if entry.is_dir(follow_symlinks=False):
                    pending.append(entry.path)
                    continue
            except OSError:
                continue
            kind = classify(entry.name)
            if kind is None:
                continue
            # A symlink pointing outside the root is a file this pack cannot
            # open: `get_annotated_filepath` resolves the link and then refuses
            # it for leaving the folder, so listing it would offer a thumbnail
            # that fails at execute time with "not in the input folder any
            # more" — about a file that is plainly sitting right there.
            #
            # Not worked around: the containment check is core's and is the
            # thing standing between a crafted filename and the rest of the
            # disk. Symlinking media into input/ does not work; the flag that
            # does is `--input-directory`, and the README says so.
            #
            # `is_symlink` reads the type the enumeration already returned, so
            # what cost a syscall per file now costs one per symlink.
            if entry.is_symlink() and not folder_paths.is_within_directory(root, entry.path):
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            relative = f"{subfolder}/{entry.name}" if subfolder else entry.name
            assets.append({
                "path": relative + annotation,
                "name": entry.name,
                "subfolder": subfolder,
                "kind": kind,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
            })
    return assets, folders


def input_path(request):
    """The absolute path behind a `?filename=` query, or None if it is not ours."""
    filename = request.query.get("filename", "")
    if not filename or not folder_paths.exists_annotated_filepath(filename):
        return None
    return folder_paths.get_annotated_filepath(filename)


def read_embedded(path, keys=("prompt", "workflow")):
    """The `prompt` and `workflow` a finished render carries in its own file.

    Both save nodes write them — `MiniMaxH3Save` into the MP4's container tags,
    `MiniMaxH3SaveImage` into the PNG's text chunks — for the reason core's
    savers do: a render dropped back onto the canvas rebuilds the node that made
    it. Which means the file already holds every field a preset wants, and the
    only thing missing was a way for the browser to read it.

    Two readers because they are two containers, chosen by extension rather than
    by trying one and catching: `av` cannot see a PNG's text chunks and PIL
    cannot open an MP4, so a fallback chain here would only turn "the wrong
    reader" into "no metadata", which is the same answer for a file that has
    none and a file we failed to read.

    A value that is not JSON comes back as None rather than raising. These tags
    are written by whoever wrote the file, which is not always this pack — a
    render remuxed by ffmpeg keeps the tag and can lose the end of it.

    Callers needing producer provenance opt into that key; preset/workflow
    readers retain the original two-field response by default.
    """
    if os.path.splitext(path)[1].lower() in (".png", ".webp"):
        from PIL import Image

        with Image.open(path) as image:
            raw = {key: image.info.get(key) for key in keys}
    else:
        import av  # ComfyUI's own decoder stack, as `server_routes._read_header`.

        with av.open(path) as container:
            raw = {key: container.metadata.get(key) for key in keys}

    out = {}
    for key, value in raw.items():
        try:
            out[key] = json.loads(value) if value else None
        except (TypeError, ValueError):
            out[key] = None
    return out


def picker_root(name):
    """The absolute path of a root the picker browses, or None.

    Named rather than derived from a file, because the folder routes act on a
    directory and a directory has no ` [output]` suffix to read a root out of. Same two roots either way — nothing here rearranges `[temp]`.
    """
    if name == "output":
        return os.path.realpath(folder_paths.get_output_directory())
    if name in ("input", "", None):
        return os.path.realpath(folder_paths.get_input_directory())
    return None


def clean_subfolder(raw):
    """A user-typed shelf name as a safe root-relative directory, or None.

    Rejects rather than sanitizes: a name that needs rewriting to be safe is a
    name the user should see refused, not silently changed.
    """
    raw = str(raw).strip().strip("/")
    if not raw:
        return ""
    parts = raw.replace("\\", "/").split("/")
    if any(not p or p.startswith(".") for p in parts):
        return None
    return "/".join(parts)


def reveal_command(path):
    """The OS's own "show me this folder", as an argv."""
    if sys.platform == "darwin":
        return ["open", path]
    if sys.platform.startswith("win"):
        return ["explorer", path]
    return ["xdg-open", path]
