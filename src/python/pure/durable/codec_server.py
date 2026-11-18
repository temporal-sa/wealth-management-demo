"""Codec server: lets the Temporal UI show claim-checked payloads.

With claim check on (USE_CLAIM_CHECK=true), the event history in the Temporal UI holds only
claim check IDs. Point the UI's codec server setting at this server, and the UI sends the
payloads here to be decoded, looking each one up in Redis (REDIS_HOST / REDIS_PORT).

It accepts requests from the local Temporal UI (http://localhost:8233) and Temporal Cloud
(https://cloud.temporal.io) only. Start it with startcodecserver.sh; it listens on
http://127.0.0.1:8081.
"""

from functools import partial
from typing import Awaitable, Callable, Iterable, List

from aiohttp import hdrs, web
from google.protobuf import json_format
from temporalio.api.common.v1 import Payload, Payloads

from common.claim_check import ClaimCheckCodec

ALLOWED_ORIGINS = {"http://localhost:8233", "https://cloud.temporal.io"}
HOST, PORT = "127.0.0.1", 8081


def _set_cors_headers(req: web.Request, resp: web.StreamResponse) -> None:
    origin = req.headers.get(hdrs.ORIGIN)
    if origin in ALLOWED_ORIGINS:
        resp.headers[hdrs.ACCESS_CONTROL_ALLOW_ORIGIN] = origin
        resp.headers[hdrs.VARY] = "Origin"
        resp.headers[hdrs.ACCESS_CONTROL_ALLOW_METHODS] = "POST, OPTIONS"
        resp.headers[hdrs.ACCESS_CONTROL_ALLOW_HEADERS] = "content-type, x-namespace, authorization"
        resp.headers[hdrs.ACCESS_CONTROL_ALLOW_CREDENTIALS] = "true"


async def _preflight(req: web.Request) -> web.Response:
    resp = web.Response(status=204)
    _set_cors_headers(req, resp)
    return resp


async def _apply(fn: Callable[[Iterable[Payload]], Awaitable[List[Payload]]], req: web.Request) -> web.Response:
    if req.content_type != "application/json":
        return web.Response(status=415, text="Expected application/json")
    payloads = json_format.Parse(await req.read(), Payloads())
    resp = web.Response(content_type="application/json",
                        text=json_format.MessageToJson(Payloads(payloads=await fn(payloads.payloads))))
    _set_cors_headers(req, resp)
    return resp


def build_codec_server(codec: ClaimCheckCodec | None = None) -> web.Application:
    codec = codec or ClaimCheckCodec()
    app = web.Application()
    app.add_routes([
        web.post("/encode", partial(_apply, codec.encode)),
        web.post("/decode", partial(_apply, codec.decode)),
        web.options("/encode", _preflight),
        web.options("/decode", _preflight),
    ])
    return app


if __name__ == "__main__":
    web.run_app(build_codec_server(), host=HOST, port=PORT)
