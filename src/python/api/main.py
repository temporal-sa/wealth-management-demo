import asyncio
from contextlib import asynccontextmanager
from typing import Optional, AsyncGenerator

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from temporalio.client import Client
from temporalio.exceptions import TemporalError
from temporalio.service import RPCError

from api import client as chat
from api.frameworks import Framework, ignored_overrides, selected_frameworks
from common.chaos_manager import CHAOS_FLAGS, ChaosFlag, ChaosManager
from common.event_stream_manager import EventStreamManager
from common.client_helper import ClientHelper
from common.session_scope import is_session_id, new_chat_workflow_id, new_session_id, owns_workflow

temporal_client: Optional[Client] = None
# The frameworks the API serves (AI_FRAMEWORK), by name, in the order the web UI shows their tabs
frameworks: dict[str, Framework] = {}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # app startup
    print("API is starting up...")
    global temporal_client
    global frameworks
    served = selected_frameworks()
    frameworks = {framework.name: framework for framework in served}
    for framework in served:
        print(f"Serving the {framework.label} AI framework ({framework.name}): chat workflows start "
              f"on task queue {framework.task_queue} with IDs starting {framework.workflow_id_prefix}")
    for name in ignored_overrides(served):
        print(f"Ignoring {name}: it applies only when the API serves one AI framework")
    client_helper = ClientHelper(default_task_queue=served[0].task_queue)
    temporal_client = await chat.connect(**client_helper.client_config)
    yield
    print("API is shutting down...")
    # app teardown
app = FastAPI(lifespan=lifespan)

# Each browser gets a random session ID in this cookie. It scopes the browser's chats (their
# workflow IDs carry it, see common/session_scope.py), chaos flags and, with DEMO_DATA_STORE=redis,
# sample data. The web UI calls the API on its own origin (/api, proxied by the React dev server),
# so the browser sends the cookie without any cross-origin setup.
SESSION_COOKIE = "wm_session"


@app.middleware("http")
async def browser_session(request: Request, call_next):
    session_id = request.cookies.get(SESSION_COOKIE)
    new_session = not is_session_id(session_id)
    if new_session:
        session_id = new_session_id()
    request.state.session_id = session_id
    response = await call_next(request)
    if new_session:
        # Secure when the browser reached us over HTTPS (directly or through a proxy)
        https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        response.set_cookie(SESSION_COOKIE, session_id, httponly=True, samesite="lax", secure=https, path="/")
    return response


def own_chat(request: Request, workflow_id: str) -> Framework:
    """The framework of the chat, if it is one of this browser session's chats; 404 otherwise.

    A chat's workflow ID starts with its framework's prefix, then the session, so the ID alone
    says which framework runs it.
    """
    for framework in frameworks.values():
        if owns_workflow(framework.workflow_id_prefix, request.state.session_id, workflow_id):
            return framework
    raise HTTPException(status_code=404, detail="No such chat in this browser session")


api = APIRouter(prefix="/api")


@app.get("/")
def root():
    return {"message": "Wealth Management Agent API"}


@api.get("/config")
async def get_config():
    """The AI frameworks this API serves, for the web UI's tabs, and whether a worker runs each one's chats."""
    available = await asyncio.gather(
        *(chat.has_workers(temporal_client, framework.task_queue) for framework in frameworks.values()))
    return {
        "frameworks": [
            {
                "framework": framework.name,
                "label": framework.label,
                "tab_label": framework.tab_label,
                "task_queue": framework.task_queue,
                "workflow_id_prefix": framework.workflow_id_prefix,
                "available": has_workers,
            }
            for framework, has_workers in zip(frameworks.values(), available)
        ]
    }


@api.get("/get-chat-history")
async def get_chat_history(
    request: Request,
    workflow_id: str,
    from_index: int = Query(0, description="Get events starting from this index")
):
    """ Retrieves the chat history from Redis """
    own_chat(request, workflow_id)
    try:
        history = await EventStreamManager().get_events_from_index(workflow_id=workflow_id, from_index=from_index)
        if history is None:
            return ""

        return history

    except Exception as e:
        error_message = str(e)
        print(f"Redis error retrieving chat history: {error_message}")

        # For other errors, return a 500
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error while querying workflow. {error_message}",
        )


@api.post("/send-prompt")
async def send_prompt(request: Request, workflow_id: str, prompt: str):
    own_chat(request, workflow_id)
    print(f"Received prompt {prompt}")

    try:
        message = await chat.send_prompt(temporal_client, workflow_id, prompt)
        print(f"Sent message {message}")
        response = "Message sent"
    except RPCError as e:
        response = f"Error: {e}"

    return {"response": response}


@api.post("/end-chat")
async def end_chat(request: Request, workflow_id: str):
    """Sends an end_workflow signal to the workflow."""
    own_chat(request, workflow_id)
    try:
        await chat.end_chat(temporal_client, workflow_id)
        return {"message": "End chat signal sent."}
    except TemporalError as e:
        print(e)
        # Workflow not found; return an empty response
        return {}


@api.post("/approve-compliance")
async def approve_compliance(request: Request, workflow_id: str):
    """Approves the compliance review of this chat's account openings that wait for it.

    Does what localsendcomplianceapproval.sh does, from a button in the web UI, without needing
    the open-account workflow's ID.
    """
    own_chat(request, workflow_id)
    try:
        approved = await chat.approve_compliance(temporal_client, workflow_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (RPCError, TemporalError) as e:
        print(f"Error approving compliance for {workflow_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Couldn't approve compliance: {e}")
    return {"approved": approved}


@api.post("/start-workflow")
async def start_workflow(
    request: Request,
    framework: Optional[str] = Query(None, description="The AI framework to run the chat; optional if the API serves one"),
):
    """Starts a chat for this browser session, with a workflow ID the API picks, and returns the ID."""
    if framework is None and len(frameworks) == 1:
        framework = next(iter(frameworks))
    if framework not in frameworks:
        served = ", ".join(frameworks)
        detail = (f"Unknown AI framework {framework!r}." if framework else "No AI framework given.")
        raise HTTPException(status_code=400, detail=f"{detail} This API serves: {served}")
    chosen = frameworks[framework]
    workflow_id = new_chat_workflow_id(chosen.workflow_id_prefix, request.state.session_id)
    try:
        await chat.start_chat(temporal_client, workflow_id, chosen.task_queue)
        return {"message": "Workflow started.", "workflow_id": workflow_id}
    except Exception as e:
        print(f"Exception occurred starting workflow {e}")
        return {"message": f"An error occurred starting the workflow {e}"}


@api.get("/chaos")
async def get_chaos(request: Request):
    """This browser session's failure-injection flags, plus the failures they recently caused."""
    manager = ChaosManager(session_id=request.state.session_id)
    try:
        enabled = await manager.get_flags()
        return {
            "flags": [
                {
                    "flag": info.flag.value,
                    "label": info.label,
                    "description": info.description,
                    "enabled": enabled[info.flag.value],
                }
                for info in CHAOS_FLAGS
            ],
            "events": await manager.get_events(),
        }
    finally:
        await manager.close()


@api.post("/chaos")
async def set_chaos(request: Request, flag: str, enabled: bool):
    try:
        chaos_flag = ChaosFlag(flag)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown chaos flag: {flag}")
    manager = ChaosManager(session_id=request.state.session_id)
    try:
        await manager.set_enabled(chaos_flag, enabled)
        return {"flag": flag, "enabled": enabled}
    finally:
        await manager.close()


@api.post("/chaos/reset")
async def reset_chaos(request: Request):
    """Turn every flag off and clear the failure log, for this browser session."""
    manager = ChaosManager(session_id=request.state.session_id)
    try:
        for info in CHAOS_FLAGS:
            await manager.set_enabled(info.flag, False)
        await manager.clear_events()
        return {"message": "All failure injection turned off."}
    finally:
        await manager.close()


app.include_router(api)
