"""The sheet: `/continuity/plate` writes an accepted one, `/plate/panel` cuts
one panel for the editor's live preview. See `creator/plate.py`."""

import asyncio
import json
import logging

from aiohttp import web
from server import PromptServer

from .. import jobs, media, plate
from ..guard import same_origin


def _plate_panels(body):
    """The panels a plate request describes, with only what the pixels need."""
    panels = []
    for panel in body.get("panels") or []:
        path = str(panel.get("path") or "").strip()
        if not path:
            continue
        made = {"path": path, "cut": bool(panel.get("cut"))}
        rect = panel.get("rect")
        if isinstance(rect, (list, tuple)) and len(rect) == 4:
            made["rect"] = [float(v) for v in rect]
        points = [{"x": float(p.get("x", 0)), "y": float(p.get("y", 0)),
                   "include": bool(p.get("include", True))}
                  for p in (panel.get("points") or []) if isinstance(p, dict)]
        if points:
            made["points"] = points
        crop = panel.get("crop")
        if isinstance(crop, dict) and crop:
            made["crop"] = crop
        panels.append(made)
    return panels


def _plate_models(body):
    """The matte weights a plate request names — or, unnamed, the install's
    own (`plate.default_models`), resolved here so the plate's name on disk
    says which file cut it."""
    defaults = plate.default_models()
    return {"cutout": str(body.get("model") or "") or defaults["cutout"],
            "segment": str(body.get("segment") or "") or defaults["segment"]}


def _plate_job(body):
    """One accepted sheet, on the queue. See `creator/jobs.py`."""
    return plate.build(_plate_panels(body), _plate_models(body),
                       float(body.get("backdrop", 0.5)),
                       int(body.get("width") or 1280),
                       int(body.get("height") or 704))


jobs.register("plate", _plate_job)


@PromptServer.instance.routes.post("/continuity/plate")
@same_origin
async def build_plate(request):
    """Write the accepted sheet. See `creator/plate.py`.

    Posted when the sheet editor's Accept (or the picker's Add over an already
    confirmed group) commits — never while the sheet is merely being edited,
    which is what keeps `_plates/` holding only sheets somebody chose to keep.
    The editing preview never touches this route: it composites in the browser
    from `/plate/panel` cutouts, which are served from memory.

    Errors come back as `{"error": …}` with a 400 rather than as a 500, because
    every way this fails is something the user can act on — no model picked, a
    file that has been deleted out from under the picker, an install without
    core's background removal — and the editor puts the sentence on the sheet
    where the picture would have been.
    """
    body = await request.json()
    panels = _plate_panels(body)
    if not panels:
        return web.json_response({"error": "a plate needs at least one picture"},
                                 status=400)

    # A sheet with nothing cut out is a resize and a paste: no weights, no GPU.
    # It is answered inside the request, because a plain sheet queued behind a
    # render greyed the picker's Add for the length of the render with nothing
    # on screen saying why (#89) — and the six pictures picked in order were
    # lost to the only button that still worked, Cancel.
    if not any(panel.get("cut") for panel in panels):
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, lambda: _plate_job(body))
        except Exception as exc:                   # noqa: BLE001 — reported, not swallowed
            logging.exception("[MiniMax] laying out a plate failed")
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response({"result": result})

    # A cut panel is a forward pass through BiRefNet, and a sheet is one per
    # panel — queued rather than run on a thread beside the prompt queue. See
    # `creator/jobs.py`.
    try:
        prompt_id = await jobs.submit("plate", body, body.get("client_id"))
    except jobs.JobError as exc:
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response({"prompt_id": prompt_id})


# The sheet editor's per-panel cutouts, encoded once and held — bounded, and
# keyed by everything that changes the pixels (the file's stamp, the matte
# weights, the clicks), so replacing a photograph under the same name or moving
# a point makes a fresh matte rather than finding the stale one.
_PANEL_CACHE = {}
_PANEL_KEEP = 64


def _panel_png(panel, models):
    """One panel's cutout as RGBA PNG bytes — the subject over transparency.

    Transparent rather than composited, because the editor lays the panel over
    the backdrop itself: one encode serves every backdrop, and the browser's
    compositing is the same alpha-over `cutout.over` bakes on Accept.
    """
    import io as _io

    import numpy as np
    from PIL import Image

    image, alpha = plate.cut_panel(panel, models)
    rgb = image[0].clamp(0.0, 1.0).mul(255.0).round().to("cpu").numpy().astype(np.uint8)
    if alpha is None:
        made = Image.fromarray(rgb, "RGB")
    else:
        a = alpha[0].clamp(0.0, 1.0).mul(255.0).round().to("cpu").numpy().astype(np.uint8)
        made = Image.fromarray(np.dstack([rgb, a]), "RGBA")
    out = _io.BytesIO()
    made.save(out, format="PNG", compress_level=4)
    return out.getvalue()


@PromptServer.instance.routes.post("/continuity/plate/panel")
@same_origin
async def cut_plate_panel(request):
    """One panel of the sheet being edited, cut out, as a PNG — from memory,
    never from a file. This is what the editor's live preview is made of."""
    refused = jobs.refuse_if_busy()
    if refused is not None:
        return refused
    body = await request.json()
    panels = _plate_panels(body)
    if len(panels) != 1:
        return web.json_response({"error": "one panel at a time"}, status=400)
    panel, models = panels[0], _plate_models(body)

    try:
        stamp = media.stamp(panel["path"])
        key = json.dumps([stamp, models, panel.get("points") or [],
                          bool(panel.get("cut")), panel.get("crop") or {}],
                         sort_keys=True, default=str)
        png = _PANEL_CACHE.get(key)
        if png is None:
            loop = asyncio.get_running_loop()
            png = await loop.run_in_executor(
                None, lambda: _panel_png(panel, models))
            while len(_PANEL_CACHE) >= _PANEL_KEEP:
                _PANEL_CACHE.pop(next(iter(_PANEL_CACHE)))
            _PANEL_CACHE[key] = png
    except Exception as exc:                       # noqa: BLE001 — reported, not swallowed
        logging.exception("[MiniMax] cutting a panel failed")
        return web.json_response({"error": str(exc)}, status=400)
    return web.Response(body=png, content_type="image/png")
