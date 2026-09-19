"""The node that puts a saved reference into a graph: `ContinuityRefModReference`.

The still families render through graphs of core nodes (`render_image.emit`),
and a reference there is `LoadImage` → `VAEEncode` → `ReferenceLatent`. A
RefMod is that encode already done, so the graph needs one node that reads
the file and chains what it holds onto the conditioning — every reference in
it, because a Klein pack's file is a *picture set*, B latents of one person,
and both Klein packs append each of them to `reference_latents` on its own
(`refmod._klein_header`). So this is the `ReferenceLatent` step itself over a
file rather than a loader that hands back one LATENT: a file of one reference
is one entry, a set of twenty-two is twenty-two, and the family's cap on
pictures stays a cap on pictures.

`space` is the family's latent space (`declare.REFMOD["space"]`), and a file
in another is refused by name here, at the graph, since the compiler never
opens the file: a Klein still handed somebody's H3 mod says so rather than
attending to a tensor of the wrong shape.

H3 reads its mods on the render thread inside its own encode
(`families/h3/encode._mod_of`) and never needs a node.
"""

import node_helpers
from comfy_api.latest import io

from . import media, refmod


class ContinuityRefModReference(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ContinuityRefModReference",
            display_name="Continuity RefMod Reference",
            category="Continuity",
            description="Chain a saved reference (models/refmods) onto the conditioning "
                        "as reference latents — every reference the file holds.",
            inputs=[io.Conditioning.Input("conditioning"),
                    io.String.Input("name", default=""),
                    io.String.Input("space", default=refmod.KLEIN_SPACE)],
            outputs=[io.Conditioning.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, conditioning, name, space, **kwargs):
        # The file's stamp beside its name: `media.stamp` is path, mtime and
        # size, so a mod remade in place is not served from the cache.
        try:
            return (name, space, media.stamp(name))
        except media.MediaError:
            return (name, space, None)

    @classmethod
    def execute(cls, conditioning, name, space) -> io.NodeOutput:
        try:
            path = refmod.resolve(name)
            meta = refmod.header(path)
            if meta["space"] != space:
                raise refmod.RefModError(
                    f"{name} is a {refmod.space_label(meta['space'])} RefMod, and this "
                    f"family reads {refmod.space_label(space)} ones — hang the picture "
                    f"it was made of on the member instead")
            latents = refmod.load_latents(path, meta)
        except refmod.RefModError as exc:
            raise ValueError(str(exc)) from exc
        return io.NodeOutput(node_helpers.conditioning_set_values(
            conditioning, {"reference_latents": latents}, append=True))


NODES = [ContinuityRefModReference]
