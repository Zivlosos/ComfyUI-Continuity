"""A saved reference is read off its header, and compiles as an ordinary picture.

`creator/refmod.py` reads the sibling pack's safetensors format with the stdlib
alone, so this runs without torch or ComfyUI:

    python3 tests/test_refmod.py

Two claims. The reader accepts exactly the files the format describes — a
`latent` of `[1, 24, T, H, W]` under `refmod_meta` — and refuses, by name, the
ones it cannot use: a newer format version, an audio mod, an odd grid, a
metadata block that disagrees with the tensor. And `compile.py` treats a mod as
the reference it is: it takes a `<Picture N>` like a photograph, a cast member
can be built out of it, and the things a mod cannot do (be a keyframe, be
trimmed, be cut, carry a soundtrack) are refused with a sentence.
"""

import json
import os
import struct
import tempfile

import layout
from harness import FAILURES, check, passed

_pkg = layout.load("canvas", "h3_declare", "contextir", "subjects", "refmod", "compile",
                   package="mmc")
compiler, refmod = _pkg.compile, _pkg.refmod

ROOT = tempfile.mkdtemp(prefix="mmc-refmods-")


def write_mod(name, meta, shape=(1, 24, 1, 16, 16), key=refmod.META_KEY, dtype="F16"):
    """A safetensors file by hand: 8-byte header length, JSON table, zeros."""
    count = 1
    for dim in shape:
        count *= dim
    width = 2 if dtype == "F16" else 4
    table = {"latent": {"dtype": dtype, "shape": list(shape), "data_offsets": [0, count * width]}}
    if meta is not None:
        table["__metadata__"] = {key: json.dumps(meta)}
    body = json.dumps(table).encode("utf-8")
    path = os.path.join(ROOT, *name.split("/")) + refmod.EXT
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(body)))
        handle.write(body)
        handle.write(b"\0" * count * width)
    return path


def refused(label, fn, fragment):
    try:
        fn()
    except refmod.RefModError as exc:
        if fragment.lower() not in str(exc).lower():
            FAILURES.append(f"{label}: error {str(exc)!r} does not mention {fragment!r}")
    except Exception as exc:  # noqa: BLE001
        FAILURES.append(f"{label}: raised {type(exc).__name__} instead of RefModError: {exc}")
    else:
        FAILURES.append(f"{label}: expected a RefModError, got none")


# ---- names ----------------------------------------------------------------------

check("the scheme is recognised", refmod.is_mod("refmod:cast/anna"), True)
check("...and a picture is not a mod", refmod.is_mod("anna.png"), False)
check("a name loses its scheme", refmod.name_of("refmod:cast/anna"), "cast/anna")
check("...its extension", refmod.name_of("refmod:anna.safetensors"), "anna")
check("...and Windows separators", refmod.name_of("refmod:cast\\anna"), "cast/anna")
for bad in ("refmod:", "refmod:../anna", "refmod:cast/../../etc", "refmod:."):
    refused(f"{bad!r} is refused", lambda bad=bad: refmod.name_of(bad), "not a RefMod name")

# ---- the header --------------------------------------------------------------

good = write_mod("cast/anna", {"name": "anna", "kind": "image", "mode": "training",
                               "description": "a woman in a green coat",
                               "_format_version": 4})
meta = refmod.header(good)
check("an image mod reads", (meta["kind"], meta["latent_t"], meta["latent_h"], meta["latent_w"]),
      ("image", 1, 16, 16))
check("...with its token cost", meta["tokens"], 64)
check("...its mode", meta["mode"], "training")
check("...and its words", meta["description"], "a woman in a green coat")

clip = write_mod("walk", {"kind": "video", "mode": "encode"}, shape=(1, 24, 3, 32, 48))
meta = refmod.header(clip)
check("a video mod reads", (meta["kind"], meta["latent_t"], meta["tokens"]), ("video", 3, 3 * 16 * 24))
check("a mode alias is folded", refmod.header(write_mod("alias", {"kind": "image", "mode": "Full Reference"}))["mode"],
      "encode")
check("an old file with no version is version 1",
      refmod.header(write_mod("old", {"kind": "image"}))["format_version"], 1)

refused("a newer format is refused",
        lambda: refmod.header(write_mod("new", {"kind": "image", "_format_version": 6})), "newer")

# ---- the spaces ----------------------------------------------------------------
#
# A latent belongs to one VAE. The sibling pack's files say nothing and are
# H3's, read off their 24 channels; ours name the space, and a Flux 2 mod is a
# 4-D 128-channel latent whose every cell is a token.

check("a sibling file is in H3's space", refmod.header(good)["space"], "h3_video")
klein = write_mod("cast/anna.flux2", {"kind": "image", "mode": "encode", "vae_kind": "flux2"},
                  shape=(1, 128, 48, 64))
kmeta = refmod.header(klein)
check("a Flux 2 mod reads in its own space",
      (kmeta["space"], kmeta["latent_t"], kmeta["latent_h"], kmeta["latent_w"]), ("flux2", 1, 48, 64))
check("...and a cell is a token there", kmeta["tokens"], 48 * 64)
check("...with an odd grid allowed", refmod.header(write_mod(
    "odd2", {"kind": "image", "vae_kind": "flux2"}, shape=(1, 128, 47, 63)))["tokens"], 47 * 63)
check("a nameless 4-D 128-channel file is Flux 2's too",
      refmod.header(write_mod("bare4", {"kind": "image"}, shape=(1, 128, 8, 8)))["space"], "flux2")
refused("a space this pack does not read is refused",
        lambda: refmod.header(write_mod("wan", {"kind": "image", "vae_kind": "wan22"},
                                        shape=(1, 48, 1, 8, 8))), "does not read")
refused("a Flux 2 file with H3's shape is refused",
        lambda: refmod.header(write_mod("mixed", {"kind": "image", "vae_kind": "flux2"},
                                        shape=(1, 24, 1, 16, 16))), "Flux 2")
refused("a clip in a still space is refused",
        lambda: refmod.header(write_mod("kclip", {"kind": "video", "vae_kind": "flux2"},
                                        shape=(1, 128, 8, 8))), "still space")
check("the row says whose it is",
      (refmod.row_for(klein, "cast/anna.flux2")["space"],
       refmod.row_for(klein, "cast/anna.flux2")["space_label"]), ("flux2", "Flux 2"))

# ---- the Klein packs' files ----------------------------------------------------
#
# malcolmrey's generator (the browser's `fk9_*_refmod` files) writes one
# `samples` batch, B pictures of one person, under `klein9_refmod_meta`;
# DainamoLabs writes `reference_<i>` tensors under `klein_refmod_meta`. Both
# unroll a file into one reference per picture, and so does the header.


def write_klein(name, key, tensors, meta):
    table, offset = {}, 0
    for tkey, shape in tensors:
        count = 1
        for dim in shape:
            count *= dim
        table[tkey] = {"dtype": "BF16", "shape": list(shape), "data_offsets": [offset, offset + count * 2]}
        offset += count * 2
    table["__metadata__"] = {key: json.dumps(meta)}
    body = json.dumps(table).encode("utf-8")
    path = os.path.join(ROOT, name + refmod.EXT)
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(body)))
        handle.write(body)
        handle.write(b"\0" * offset)
    return path


adele = write_klein("fk9_adele_v1_refmod", "klein9_refmod_meta", [("samples", (22, 128, 32, 32))],
                    {"name": "fk9_adele_v1_refmod", "concept_type": "identity", "mode": "encode",
                     "resolution": 1024, "token_budget": 256, "generator": "ComfyUI-Flux2Klein9Mod"})
ameta = refmod.header(adele)
check("a browser Klein file is a set of pictures in Flux 2's space",
      (ameta["space"], ameta["kind"], ameta["members"], ameta["latent_h"], ameta["latent_w"]),
      ("flux2", "image", 22, 32, 32))
check("...costing every picture's cells", ameta["tokens"], 22 * 32 * 32)
check("...read row by row off the batch",
      ameta["tensors"][:2] + ameta["tensors"][-1:], [("samples", 0), ("samples", 1), ("samples", 21)])
check("...a full encode, by their word", ameta["mode"], "encode")
check("the row says it is a set", refmod.row_for(adele, "fk9_adele_v1_refmod")["members"], 22)
pooled = write_klein("pooled", "klein9_refmod_meta", [("samples", (1, 128, 16, 16))],
                     {"mode": "pooled"})
check("...and their pooled is compressed", refmod.header(pooled)["mode"], "training")
dain = write_klein("dain", "klein_refmod_meta",
                   [("reference_0", (1, 128, 64, 48)), ("reference_1", (1, 128, 32, 32))],
                   {"format_version": 1, "name": "dain", "concept_type": "identity"})
dmeta = refmod.header(dain)
check("a DainamoLabs file reads each reference at its own shape",
      (dmeta["members"], dmeta["tokens"], dmeta["tensors"]),
      (2, 64 * 48 + 32 * 32, [("reference_0", None), ("reference_1", None)]))
refused("a Klein file of the wrong shape is refused",
        lambda: refmod.header(write_klein("bad", "klein9_refmod_meta", [("samples", (1, 24, 1, 16, 16))], {})),
        "not [B, 128, H, W]")

# ---- a version-5 bundle -------------------------------------------------------
#
# The sibling pack's newer files: several references as `ref_<i>` tensors
# under one header. One visual reference is one mod and reads as one, off its
# own key; several is several labels behind one handle and is refused.


def write_bundle(name, members, shapes):
    table = {}
    offset = 0
    for index, shape in enumerate(shapes):
        count = 1
        for dim in shape:
            count *= dim
        table[f"ref_{index}"] = {"dtype": "F16", "shape": list(shape),
                                 "data_offsets": [offset, offset + count * 2]}
        offset += count * 2
    meta = {"_format_version": 5, "kind": "bundle", "name": name, "members": members}
    table["__metadata__"] = {refmod.META_KEY: json.dumps(meta)}
    body = json.dumps(table).encode("utf-8")
    path = os.path.join(ROOT, name + refmod.EXT)
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(body)))
        handle.write(body)
        handle.write(b"\0" * offset)
    return path


one = write_bundle("walk5", [{"_format_version": 4, "kind": "video", "mode": "training",
                              "description": "her walk", "latent_t": 6}],
                   [(1, 24, 6, 16, 16)])
bmeta = refmod.header(one)
check("a one-reference bundle reads as that reference",
      (bmeta["kind"], bmeta["latent_t"], bmeta["tokens"], bmeta["tensor"], bmeta["description"]),
      ("video", 6, 6 * 64, "ref_0", "her walk"))
with_voice = write_bundle("pair5", [{"kind": "audio"}, {"kind": "image", "mode": "encode"}],
                          [(1, 32, 2, 40), (1, 24, 1, 16, 16)])
check("...and its voice is skipped, the picture read off its own key",
      (refmod.header(with_voice)["kind"], refmod.header(with_voice)["tensor"]), ("image", "ref_1"))
refused("a bundle of several is refused by count",
        lambda: refmod.header(write_bundle("two5", [{"kind": "image"}, {"kind": "image"}],
                                           [(1, 24, 1, 16, 16), (1, 24, 1, 16, 16)])), "bundle of 2")
refused("a bundle of voices alone is an audio mod",
        lambda: refmod.header(write_bundle("voice5", [{"kind": "audio"}], [(1, 32, 2, 40)])), "audio")

# ---- an asset's renditions ---------------------------------------------------------

check("mods parse by space", refmod.parse_mods({"h3_video": "refmod:cast/anna", "flux2": ""}),
      {"h3_video": "refmod:cast/anna"})
check("...and nothing is nothing", refmod.parse_mods(None), {})
refused("a space nobody reads is refused in mods",
        lambda: refmod.parse_mods({"wan22": "refmod:x"}), "does not read")
refused("a mod that is not one is refused in mods",
        lambda: refmod.parse_mods({"flux2": "anna.png"}), "not a RefMod name")
refused("...and a name walking out of the folder",
        lambda: refmod.parse_mods({"flux2": "refmod:../x"}), "not a RefMod name")
refused("an audio mod is refused",
        lambda: refmod.header(write_mod("voice", {"kind": "audio"}, shape=(1, 32, 2, 40))), "audio")
refused("...under the sibling's audio key too",
        lambda: refmod.header(write_mod("voice2", {"kind": "audio"}, shape=(1, 32, 2, 40),
                                        key="audio_refmod_meta")), "audio")
refused("an odd grid is refused",
        lambda: refmod.header(write_mod("odd", {"kind": "image"}, shape=(1, 24, 1, 15, 16))), "not even")
refused("an image mod with several frames is refused",
        lambda: refmod.header(write_mod("multi", {"kind": "image"}, shape=(1, 24, 4, 16, 16))), "frames")
refused("a wrong channel count is refused",
        lambda: refmod.header(write_mod("chan", {"kind": "image"}, shape=(1, 16, 1, 16, 16))), "not [1, 24")
refused("a file with no metadata is refused",
        lambda: refmod.header(write_mod("bare", None)), "no RefMod metadata")


def write_lora(name):
    table = {"lora_unet_single_blocks_0_linear1.lora_down.weight":
             {"dtype": "F16", "shape": [4, 8], "data_offsets": [0, 64]},
             "__metadata__": {"ss_steps": "400"}}
    body = json.dumps(table).encode("utf-8")
    path = os.path.join(ROOT, name + refmod.EXT)
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(body)))
        handle.write(body)
        handle.write(b"\0" * 64)
    return path


refused("a LoRA dropped here is named as one, with where it goes",
        lambda: refmod.header(write_lora("flux_someone_v1-step00000400")), "a LoRA, not a RefMod")
refused("a missing file is refused", lambda: refmod.header(os.path.join(ROOT, "nope.safetensors")), "nope")
with open(os.path.join(ROOT, "junk.safetensors"), "wb") as handle:
    handle.write(b"PNG\r\n\x1a\n" + b"\0" * 20)
refused("a file that is not safetensors is refused",
        lambda: refmod.header(os.path.join(ROOT, "junk.safetensors")), "not a safetensors")

# ---- the pooled grid -----------------------------------------------------------

check("a square source pools to the dial", refmod.grid_for(64, 64, 16), (16, 16))
check("a tall source keeps its aspect", refmod.grid_for(96, 64, 24), (24, 16))
check("a wide source keeps its aspect", refmod.grid_for(48, 96, 16), (8, 16))
check("...rounded to even", refmod.grid_for(90, 64, 16), (16, 12))
check("a grid never exceeds the source", refmod.grid_for(8, 8, 32), (8, 8))

# ---- compiling with one ----------------------------------------------------------


def build(prompt="", assets=(), **rest):
    data = {"prompt": prompt, "assets": list(assets), "duration_s": 6,
            "aspect": "16:9", "short_edge": 768}
    data.update(rest)
    return compiler.compile_request(data, image_size_lookup=lambda _f: (1500, 1000))


def expect_error(label, fn, fragment):
    try:
        fn()
    except compiler.CompileError as exc:
        if fragment.lower() not in str(exc).lower():
            FAILURES.append(f"{label}: error {str(exc)!r} does not mention {fragment!r}")
    except Exception as exc:  # noqa: BLE001
        FAILURES.append(f"{label}: raised {type(exc).__name__} instead of CompileError: {exc}")
    else:
        FAILURES.append(f"{label}: expected a CompileError, got none")


def mod(handle, kind="image", **rest):
    return {"handle": handle, "kind": kind, "role": "reference",
            "filename": f"refmod:cast/{handle}", **rest}


def picture(handle, **rest):
    return {"handle": handle, "kind": "image", "role": "reference",
            "filename": f"{handle}.png", **rest}


compiled = build("@img-1 and @img-2 walk in", [picture("img-1"), mod("img-2")])
check("a mod is a picture in the plan",
      [(step["op"], step["asset"].handle, step["label"]) for step in compiled.plan],
      [("image", "img-1", "<Picture 1>"), ("image", "img-2", "<Picture 2>")])
check("...and knows it is a mod", [a.mod for a in compiled.ref_images], [False, True])
check("a video mod is a video in the plan",
      [step["label"] for step in build("@vid-1", [mod("vid-1", "video")]).plan], ["<Video 1>"])
check("a video mod carries no soundtrack",
      build("@vid-1", [mod("vid-1", "video")]).ref_videos[0].track, "picture")

cast = build("@anna smiles", [mod("img-1")],
             subjects=[{"handle": "anna", "from": ["img-1"], "takes": "person"}])
check("a member can be built out of a mod",
      [s.sources for s in cast.cast], [("img-1",)])
check("...and their definition cites it",
      "<Subject 1> is the person in <Picture 1>" in cast.prompt, True)

expect_error("a mod cannot open a shot",
             lambda: build("", [dict(mod("img-1"), role="first_frame")]), "no frame to open")
expect_error("...or be a guide",
             lambda: build("", [dict(mod("vid-1", "video"), role="guide")]), "nothing to aim")
expect_error("a mod cannot be trimmed",
             lambda: build("@vid-1", [mod("vid-1", "video", trim={"start": 0, "end": 1})]), "trimmed")
expect_error("...or cut", lambda: build("@img-1", [mod("img-1", cut=True)]), "already encoded")
expect_error("...or lend a soundtrack",
             lambda: build("@vid-1", [mod("vid-1", "video", track="picture+sound")]), "no soundtrack")
expect_error("an audio mod is refused",
             lambda: build("@aud-1", [mod("aud-1", "audio")]), "audio RefMod")
expect_error("a bad name is refused",
             lambda: build("@img-1", [{"handle": "img-1", "kind": "image", "role": "reference",
                                       "filename": "refmod:../x"}]), "not a RefMod name")

# A picture carrying its renditions: the picture is the reference, and the
# family rendering it asks for the mod in its own space.
bound = build("@img-1 walks", [picture("img-1", mods={"h3_video": "refmod:cast/anna",
                                                        "flux2": "refmod:cast/anna.flux2"})])
asset = bound.ref_images[0]
check("a picture with renditions is still a picture", (asset.mod, asset.filename), (False, "img-1.png"))
check("...and answers each family in its space",
      (asset.mod_for("h3_video"), asset.mod_for("flux2"), asset.mod_for("ltx_video")),
      ("refmod:cast/anna", "refmod:cast/anna.flux2", None))
check("a mod answers itself", build("@img-1", [mod("img-1")]).ref_images[0].mod_for("h3_video"),
      "refmod:cast/img-1")
check("a picture without any is encoded", build("@img-1", [picture("img-1")]).ref_images[0].mods, {})
expect_error("renditions on a keyframe are refused",
             lambda: build("", [dict(picture("img-1"), role="first_frame",
                                     mods={"h3_video": "refmod:cast/anna"})]), "used as it is")
expect_error("...and on a mod",
             lambda: build("@img-1", [mod("img-1", mods={"flux2": "refmod:cast/anna.flux2"})]),
             "one rendition already")
expect_error("...and for a space nobody reads",
             lambda: build("@img-1", [picture("img-1", mods={"wan22": "refmod:x"})]), "does not read")

# ---- the file itself ---------------------------------------------------------------
#
# Rename, delete, describe and adopt work through `folder_paths` for the roots,
# so a stub answering with ROOT stands in for ComfyUI here.

import sys
import types

_fp = types.ModuleType("folder_paths")
_fp.models_dir = ROOT
_fp.add_model_folder_path = lambda *_a, **_k: None
_fp.get_folder_paths = lambda _name: [ROOT]
_fp.is_within_directory = lambda root, path: os.path.realpath(path).startswith(os.path.realpath(root))
sys.modules["folder_paths"] = _fp

_moved_src = write_mod("cast/mover", {"kind": "image", "mode": "training", "description": "before"})
with open(os.path.splitext(_moved_src)[0] + ".png", "wb") as _h:
    _h.write(b"png")
_new = refmod.move("refmod:cast/mover", "people/moved")
check("a mod moves with its picture",
      (os.path.isfile(_new), os.path.isfile(os.path.splitext(_new)[0] + ".png"),
       os.path.isfile(_moved_src)), (True, True, False))
check("...and the row says where it is", refmod.row_for(_new, "people/moved")["subfolder"], "people")
write_mod("people/taken", {"kind": "image"})
refused("a move never overwrites", lambda: refmod.move("refmod:people/moved", "people/taken"), "already there")

refmod.rewrite_meta(_new, description="after")
_meta = refmod.header(_new)
check("the description is rewritten in place", _meta["description"], "after")
check("...and the tensor still reads", (_meta["tokens"], _meta["kind"]), (64, "image"))
with open(_new, "rb") as _h:
    (_len,) = struct.unpack("<Q", _h.read(8))
check("...with the header padded to eight", _len % 8, 0)

_tmp = write_mod("_incoming", {"kind": "image", "mode": "encode"})
_adopted, _ = refmod.adopt(_tmp, "cast/adopted")
check("an upload is adopted under its name", os.path.isfile(_adopted) and not os.path.exists(_tmp), True)
_junk = os.path.join(ROOT, "junk.tmp")
with open(_junk, "wb") as _h:
    _h.write(b"not a safetensors file at all")
refused("...and a file that is not a mod is refused", lambda: refmod.adopt(_junk, "cast/junk"), "safetensors")
check("...and deleted", os.path.exists(_junk), False)

refmod.remove("refmod:people/moved")
check("a deleted mod is gone with its picture",
      (os.path.exists(_new), os.path.exists(os.path.splitext(_new)[0] + ".png")), (False, False))
check("a foreign mod is marked", refmod.row_for(_adopted, "cast/adopted")["foreign"], True)

passed("all RefMod contract tests passed")
