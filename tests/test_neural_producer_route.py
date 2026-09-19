"""The twin route queues the identified producer's closure and names the output.

    python3 tests/test_neural_producer_route.py

Runs the actual route module over a stub `PromptServer`, with in-memory
request, metadata and queue boundaries. No user file, network or GPU execution
is involved.
"""

import asyncio
import json
import sys
from types import ModuleType, SimpleNamespace


import layout
from harness import check

package = "neural_producer_route_test"
pkg = layout.load("neuraltwin", package=package)
twin = pkg.neuraltwin
prompt = {
    "A": {"class_type": "MiniMaxH3Creator", "inputs": {"creator_data": '{"neural":{"on":true}}'}},
    "B": {"class_type": "MiniMaxH3Creator", "inputs": {"creator_data": '{}', "image": ["loader", 0], "seed": 42}},
    "loader": {"class_type": "LoadImage", "inputs": {"image": "source.png"}},
    "unrelated": {"class_type": "NotInstalled", "inputs": {}},
}
embedded = {"prompt": prompt, twin.PRODUCER_KEY: {"node": "B", "index": 1}}
reads, validations, queued = [], [], []
assets = ModuleType(f"{package}.assets")


def read_embedded(path, keys):
    reads.append((path, keys))
    return {key: embedded.get(key) for key in keys}


assets.read_embedded = read_embedded
assets.input_path = lambda request: "in-memory-file.png"
sys.modules[assets.__name__] = assets
pkg.assets = assets
media = ModuleType(f"{package}.media")
media.resolve = lambda filename: filename
sys.modules[media.__name__] = media
pkg.media = media
execution = ModuleType("execution")


async def validate(prompt_id, graph, targets):
    validations.append((graph, targets))
    return True, None, targets, {}


execution.validate_prompt = validate
sys.modules["execution"] = execution
layout.stub_server()
server = sys.modules["server"].PromptServer.instance   # the routes' own, so the queue is on it
server.number = 1
server.prompt_queue = SimpleNamespace(put=queued.append)
route = layout.load("neural_route", package=package).neural_route


class Request:
    async def json(self):
        return {"filename": "in-memory-file.png", "on": True, "block": {"detail": 3}, "client_id": "test"}


async def run():
    response = await route.neural_of(Request())
    info = json.loads(response.text)
    check("metadata endpoint reads B's closure, not the unrelated ON A", (info["node"], info["on"]), ("B", False))
    response = await route.neural_twin(Request())
    answer = json.loads(response.text)
    check("queue request succeeds", response.status, 200)
    check("response identifies output and batch index", (answer["node"], answer["index"]), ("B", 1))
    check("the whole closure validates as an ordinary prompt", validations[0][1], None)
    check("unrelated output and missing-node type removed", set(validations[0][0]), {"B", "loader"})
    check("queue preserves input link", queued[0][2]["B"]["inputs"]["image"], ["loader", 0])
    check("queue preserves seed", queued[0][2]["B"]["inputs"]["seed"], 42)
    check("no partial-execution targets", queued[0][4], None)
    check("socket client id preserved", queued[0][3], {"client_id": "test"})
    check("metadata reader requests provenance", twin.PRODUCER_KEY in reads[0][1], True)
    embedded.pop(twin.PRODUCER_KEY)
    response = await route.neural_twin(Request())
    answer = json.loads(response.text)
    check("an older file without the stamp still queues", response.status, 200)
    check("...the whole prompt, every node of ours flipped", set(queued[1][2]), set(prompt))
    check("...and leaves the output to the viewer", answer["node"], None)


asyncio.run(run())
