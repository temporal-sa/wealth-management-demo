from contextlib import asynccontextmanager
from typing import Optional, AsyncGenerator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from temporalio.client import Client
from temporalio.exceptions import TemporalError
from temporalio.service import RPCError

from api import client as chat
from api.ports import Port, selected_port
from common.chaos_manager import CHAOS_FLAGS, ChaosFlag, ChaosManager
from common.event_stream_manager import EventStreamManager
from common.client_helper import ClientHelper

temporal_client: Optional[Client] = None
task_queue: Optional[str] = None
port: Optional[Port] = None

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # app startup
    print("API is starting up...")
    global temporal_client
    global task_queue
    global port
    port = selected_port()
    client_helper = ClientHelper(default_task_queue=port.task_queue)
    task_queue = client_helper.taskQueue
    print(f"Serving the {port.label} port (CHAT_PORT={port.name}): chat workflows start on task queue "
          f"{task_queue} with IDs starting {port.workflow_id_prefix}")
    temporal_client = await chat.connect(**client_helper.client_config)
    yield
    print("API is shutting down...")
    # app teardown
app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"message": "Wealth Management Agent API"}

@app.get("/config")
def get_config():
    """The port this API serves, so the web application can name its chat workflows after it."""
    return {
        "port": port.name,
        "label": port.label,
        "task_queue": task_queue,
        "workflow_id_prefix": port.workflow_id_prefix,
        "approvals": port.approvals,
    }

@app.get("/get-chat-history")
async def get_chat_history(
    workflow_id: str,
    from_index: int = Query(0, description="Get events starting from this index")
):
    """ Retrieves the chat history from Redis """
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

@app.post("/send-prompt")
async def send_prompt(workflow_id: str, prompt: str):
    print(f"Received prompt {prompt}")

    try:
        message = await chat.send_prompt(temporal_client, workflow_id, prompt)
        print(f"Sent message {message}")
        response = "Message sent"
    except RPCError as e:
        response = f"Error: {e}"

    return {"response": response}


@app.post("/end-chat")
async def end_chat(workflow_id: str):
    """Sends an end_workflow signal to the workflow."""
    try:
        await chat.end_chat(temporal_client, workflow_id)
        return {"message": "End chat signal sent."}
    except TemporalError as e:
        print(e)
        # Workflow not found; return an empty response
        return {}

@app.get("/pending-approval")
async def pending_approval(workflow_id: str):
    """The approval question the chat is waiting on (e.g. before deleting a beneficiary), or null.

    Only ports whose chat workflow pauses for approvals answer it (GET /config "approvals").
    """
    if not port.approvals:
        return {"pending": None}
    try:
        return {"pending": await chat.pending_approval(temporal_client, workflow_id)}
    except TemporalError:
        return {"pending": None}


@app.post("/approve")
async def approve(workflow_id: str, response: str):
    """Answers the pending approval. response is "approve" or "deny"."""
    if not port.approvals:
        raise HTTPException(status_code=400, detail=f"The {port.label} port doesn't pause for approvals")
    if response not in chat.APPROVAL_RESPONSES:
        raise HTTPException(status_code=400, detail=f"response must be one of {', '.join(chat.APPROVAL_RESPONSES)}")
    try:
        await chat.answer_approval(temporal_client, workflow_id, response)
        return {"message": f"Approval response '{response}' sent."}
    except TemporalError as e:
        return {"message": f"Error: {e}"}

UPDATE_STATUS_NAME = "update_status"

@app.post("/start-workflow")
async def start_workflow(workflow_id: str):
    try:
        await chat.start_chat(temporal_client, workflow_id, task_queue)

        return {
            "message": f"Workflow started."
        }
    except Exception as e:
        print(f"Exception occurred starting workflow {e}")
        return {
            "message": f"An error occurred starting the workflow {e}"
        }


@app.get("/chaos")
async def get_chaos():
    """The failure-injection flags for the UI chaos panel, plus the failures they recently caused."""
    manager = ChaosManager()
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


@app.post("/chaos")
async def set_chaos(flag: str, enabled: bool):
    try:
        chaos_flag = ChaosFlag(flag)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown chaos flag: {flag}")
    manager = ChaosManager()
    try:
        await manager.set_enabled(chaos_flag, enabled)
        return {"flag": flag, "enabled": enabled}
    finally:
        await manager.close()


@app.post("/chaos/reset")
async def reset_chaos():
    """Turn every flag off and clear the failure log."""
    manager = ChaosManager()
    try:
        for info in CHAOS_FLAGS:
            await manager.set_enabled(info.flag, False)
        await manager.clear_events()
        return {"message": "All failure injection turned off."}
    finally:
        await manager.close()
