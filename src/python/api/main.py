from contextlib import asynccontextmanager
from typing import Optional, AsyncGenerator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from temporalio.client import Client
from temporalio.exceptions import TemporalError
from temporalio.service import RPCError

from api import client as chat
from api.frameworks import Framework, selected_framework
from common.chaos_manager import CHAOS_FLAGS, ChaosFlag, ChaosManager
from common.event_stream_manager import EventStreamManager
from common.client_helper import ClientHelper

temporal_client: Optional[Client] = None
task_queue: Optional[str] = None
framework: Optional[Framework] = None

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # app startup
    print("API is starting up...")
    global temporal_client
    global task_queue
    global framework
    framework = selected_framework()
    client_helper = ClientHelper(default_task_queue=framework.task_queue)
    task_queue = client_helper.taskQueue
    print(f"Serving the {framework.label} AI framework (AI_FRAMEWORK={framework.name}): chat workflows start "
          f"on task queue {task_queue} with IDs starting {framework.workflow_id_prefix}")
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
    """The AI framework this API serves, so the web application can name its chat workflows after it."""
    return {
        "framework": framework.name,
        "label": framework.label,
        "task_queue": task_queue,
        "workflow_id_prefix": framework.workflow_id_prefix,
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

@app.post("/approve-compliance")
async def approve_compliance(workflow_id: str):
    """Approves the compliance review of this chat's account openings that wait for it.

    Does what localsendcomplianceapproval.sh does, from a button in the web UI, without needing
    the open-account workflow's ID.
    """
    try:
        approved = await chat.approve_compliance(temporal_client, workflow_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (RPCError, TemporalError) as e:
        print(f"Error approving compliance for {workflow_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Couldn't approve compliance: {e}")
    return {"approved": approved}

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
