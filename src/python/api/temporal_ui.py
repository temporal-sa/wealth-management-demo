"""Where the Temporal UI for the API's namespace is, so the web UI can link to a chat's workflows.

The web UI builds a workflow's link as <url>/namespaces/<namespace>/workflows/<workflow ID>, the form the FieldKit
platform documents for its TEMPORAL_UI_URL and TEMPORAL_UI_NAMESPACE, which it sets on every component (the UI base,
https://cloud.temporal.io, and the qualified Cloud namespace). Without them:

* a Temporal Cloud address (<namespace>.<account>.tmprl.cloud or <region>.<cloud>.api.temporal.io) links to
  https://cloud.temporal.io, which needs a Temporal Cloud sign-in with access to the namespace;
* a local address (localhost, 127.0.0.1) links to the dev server's UI, http://localhost:8233;
* any other address (a dev server in Compose, say) has no link unless TEMPORAL_UI_URL is set.
"""
import os
from typing import Optional

CLOUD_UI = "https://cloud.temporal.io"
LOCAL_UI = "http://localhost:8233"
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def temporal_ui(address: Optional[str], namespace: Optional[str]) -> Optional[dict]:
    """{"url": ..., "namespace": ...} for the web UI's links, or None when there's no UI to link to."""
    namespace = os.getenv("TEMPORAL_UI_NAMESPACE") or namespace or "default"
    url = os.getenv("TEMPORAL_UI_URL")
    if not url:
        host = (address or "").rsplit(":", 1)[0].lower()
        if host.endswith(".tmprl.cloud") or host.endswith(".api.temporal.io"):
            url = CLOUD_UI
        elif host in _LOCAL_HOSTS:
            url = LOCAL_UI
        else:
            return None
    return {"url": url.rstrip("/"), "namespace": namespace}
