"""The node that puts a saved reference into a graph: `ContinuityRefModLatent`.

The still families render through graphs of core nodes (`render_image.emit`),
and a reference there is `LoadImage` → `VAEEncode` → `ReferenceLatent`. A
RefMod is that encode already done, so the graph needs one node that reads
the file and answers a LATENT; core has no loader for a safetensors latent in
the model folders, and this is it. One string input, the mod's own name, so
the graph cache keys on which file — plus its stamp, below, so a file
re-encoded under the same name is a different input.

Only families whose references are latents on the conditioning emit it
(Flux 2 Klein). H3 reads its mods on the render thread inside its own encode
(`families/h3/encode._mod_of`) and never needs a node.
"""

from comfy_api.latest import io

from . import media, refmod


class ContinuityRefModLatent(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ContinuityRefModLatent",
            display_name="Continuity RefMod Latent",
            category="Continuity",
            description="A saved reference (models/refmods) as the latent it holds, "
                        "for a family that chains references onto its conditioning.",
            inputs=[io.String.Input("name", default="")],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, name, **kwargs):
        # The file's stamp beside its name: `media.stamp` is path, mtime and
        # size, so a mod remade in place is not served from the cache.
        try:
            return (name, media.stamp(name))
        except media.MediaError:
            return (name, None)

    @classmethod
    def execute(cls, name) -> io.NodeOutput:
        try:
            path = refmod.resolve(name)
            meta = refmod.header(path)
            latent = refmod.load_latent(path, meta)
        except refmod.RefModError as exc:
            raise ValueError(str(exc)) from exc
        return io.NodeOutput({"samples": latent})


NODES = [ContinuityRefModLatent]
