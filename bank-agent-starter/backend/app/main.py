
import json
from typing import AsyncGenerator

from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessageChunk, HumanMessage
from langgraph.types import Command
from pydantic import BaseModel

from app.agent import banking_agent
from app.auth import get_current_user_id

load_dotenv()

app = FastAPI(title="Expo Banking LangGraph Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten to specific origins in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatStreamRequest(BaseModel):
    thread_id: str
    message: str


class ConfirmRequest(BaseModel):
    thread_id: str
    approved: bool


def _format_sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


async def _run_graph_sse(
    graph_input: dict | Command,
    thread_id: str,
    user_id: str,
) -> AsyncGenerator[str, None]:
    config = {"configurable": {"thread_id": thread_id, "user_id": user_id}}

    try:
        async for mode, chunk in banking_agent.astream(
            graph_input,
            config=config,
            stream_mode=["messages", "updates"],
        ):
            if mode == "messages":
                msg_chunk, metadata = chunk
                # Stream only assistant tokens (skip tool outputs)
                if (
                    isinstance(msg_chunk, AIMessageChunk)
                    and metadata.get("langgraph_node") == "assistant"
                    and msg_chunk.content
                    and not msg_chunk.tool_calls
                ):
                    yield _format_sse("token", {"text": msg_chunk.content})

            elif mode == "updates":
                if "__interrupt__" in chunk:
                    interrupt_obj = chunk["__interrupt__"][0]
                    interrupt_value = getattr(interrupt_obj, "value", interrupt_obj)
                    yield _format_sse("approval_required", {"interrupt": interrupt_value})

        yield _format_sse("done", {"thread_id": thread_id})
    except Exception as exc:
        yield _format_sse("error", {"message": str(exc)})


@app.post("/api/v1/agent/chat/stream")
async def chat_stream(
    req: ChatStreamRequest,
    user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    graph_input = {"messages": [HumanMessage(content=req.message)], "user_id": user_id}
    return StreamingResponse(
        _run_graph_sse(graph_input, thread_id=req.thread_id, user_id=user_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.post("/api/v1/agent/confirm")
async def confirm_action(
    req: ConfirmRequest,
    user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    resume_cmd = Command(resume={"approved": req.approved})
    return StreamingResponse(
        _run_graph_sse(resume_cmd, thread_id=req.thread_id, user_id=user_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )