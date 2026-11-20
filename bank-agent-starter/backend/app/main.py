import json
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessageChunk, HumanMessage
from langgraph.types import Command
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

load_dotenv()

from app.database import get_db, init_db
from app.auth import get_current_user_id
from app.banking import banking_service
from app.agent import banking_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize SQLite/Postgres DB schema and seed initial data
    init_db()
    yield


app = FastAPI(
    title="International Banking Core & AI Copilot API",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Pydantic Request Models ---
class ChatStreamRequest(BaseModel):
    thread_id: str
    message: str


class ConfirmRequest(BaseModel):
    thread_id: str
    approved: bool
    pin: Optional[str] = None


class TransferRequest(BaseModel):
    from_account_id: str
    to_account_id: str
    amount: float = Field(..., gt=0)


class FXConvertRequest(BaseModel):
    from_account_id: str
    to_account_id: str
    amount: float = Field(..., gt=0)


class WireTransferRequest(BaseModel):
    from_account_id: str
    recipient_name: str
    recipient_iban: str
    swift_code: str
    amount: float = Field(..., gt=0)
    currency: str = "USD"


class CardLimitRequest(BaseModel):
    limit: float = Field(..., ge=100, le=50000)


# --- REST Endpoints ---

@app.get("/api/v1/accounts")
def list_accounts(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Retrieve all user accounts and balances across currencies."""
    return {"accounts": banking_service.get_accounts(db, user_id)}


@app.get("/api/v1/accounts/{account_id}")
def get_account_detail(
    account_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    acc = banking_service.get_account(db, user_id, account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found.")
    return acc


@app.get("/api/v1/transactions")
def list_transactions(
    limit: int = 20,
    account_id: Optional[str] = None,
    category: Optional[str] = None,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Retrieve transaction history with optional filters."""
    return {"transactions": banking_service.get_transactions(db, user_id, limit, account_id, category)}


@app.get("/api/v1/cards")
def list_cards(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Retrieve all physical and virtual cards for user."""
    return {"cards": banking_service.get_cards(db, user_id)}


@app.post("/api/v1/cards/{card_id}/toggle-freeze")
def toggle_card_freeze(
    card_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Instantly toggle active/frozen status on a card."""
    try:
        return banking_service.toggle_card_freeze(db, user_id, card_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/cards/{card_id}/limit")
def update_card_limit(
    card_id: str,
    req: CardLimitRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Set maximum spending limit on a card."""
    try:
        return banking_service.set_card_limit(db, user_id, card_id, req.limit)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/v1/fx/rates")
def list_fx_rates(
    db: Session = Depends(get_db),
):
    """Fetch live foreign exchange market conversion rates."""
    return {"rates": banking_service.get_fx_rates(db)}


@app.post("/api/v1/fx/convert")
def convert_currency(
    req: FXConvertRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Convert currency directly between user's multi-currency pockets."""
    idempotency_key = f"{user_id}:fx:{req.from_account_id}:{req.to_account_id}:{req.amount}"
    try:
        return banking_service.execute_fx_conversion(
            db, user_id, req.from_account_id, req.to_account_id, req.amount, idempotency_key
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/transfers/internal")
def transfer_internal(
    req: TransferRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Direct internal funds transfer."""
    idempotency_key = f"{user_id}:tr:{req.from_account_id}:{req.to_account_id}:{req.amount}"
    try:
        return banking_service.execute_transfer(
            db, user_id, req.from_account_id, req.to_account_id, req.amount, idempotency_key
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/wires/send")
def send_wire(
    req: WireTransferRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Initiate an international SWIFT wire transfer."""
    idempotency_key = f"{user_id}:wire:{req.from_account_id}:{req.amount}:{req.swift_code}"
    try:
        return banking_service.execute_swift_wire(
            db,
            user_id,
            req.from_account_id,
            req.recipient_name,
            req.recipient_iban,
            req.swift_code,
            req.amount,
            req.currency,
            idempotency_key,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# --- AI Copilot SSE Streaming Endpoints ---

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
    resume_cmd = Command(resume={"approved": req.approved, "pin": req.pin})
    return StreamingResponse(
        _run_graph_sse(resume_cmd, thread_id=req.thread_id, user_id=user_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
