import os
import uuid
from typing import Annotated, Literal, TypedDict, Optional
from dotenv import load_dotenv

load_dotenv()

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langchain_groq import ChatGroq
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt

from app.database import SessionLocal, User
from app.banking import banking_service


class BankingState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: str
    route: Literal["ledger", "payments", "cards", "fx_wire", "general"]


def _get_user_id_from_config(config: RunnableConfig) -> str:
    user_id = (config.get("configurable") or {}).get("user_id")
    if not user_id:
        raise ValueError("Missing authenticated user_id in LangGraph config.")
    return user_id


@tool
def check_balances(config: RunnableConfig) -> dict:
    """Return all bank accounts, currencies, and current balances for the authenticated user."""
    user_id = _get_user_id_from_config(config)
    with SessionLocal() as db:
        accounts = banking_service.get_accounts(db, user_id)
        return {"accounts": accounts}


@tool
def check_transactions(
    limit: int = 10,
    category: Optional[str] = None,
    config: RunnableConfig = None,
) -> dict:
    """Return recent transaction history with optional category filtering."""
    user_id = _get_user_id_from_config(config)
    safe_limit = max(1, min(limit, 30))
    with SessionLocal() as db:
        txs = banking_service.get_transactions(db, user_id, limit=safe_limit, category=category)
        return {"transactions": txs}


@tool
def transfer_funds(
    from_account_id: str,
    to_account_id: str,
    amount: float,
    config: RunnableConfig,
) -> dict:
    """
    Transfer money between accounts.
    Requires explicit Human-In-The-Loop (HITL) approval and transaction Security PIN before moving funds.
    """
    user_id = _get_user_id_from_config(config)
    idempotency_key = f"{user_id}:transfer:{from_account_id}:{to_account_id}:{amount}:{uuid.uuid4().hex[:8]}"

    # Human-in-the-loop interrupt with PIN requirement
    approval = interrupt(
        {
            "type": "transfer_approval",
            "from_account_id": from_account_id,
            "to_account_id": to_account_id,
            "amount": amount,
            "require_pin": True,
            "idempotency_key": idempotency_key,
            "prompt": f"Confirm moving ${amount:.2f} from '{from_account_id}' to '{to_account_id}'? Enter your 4-digit transaction PIN to authorize.",
        }
    )

    if not approval or approval.get("approved") is not True:
        return {"status": "cancelled", "message": "Transfer cancelled by the account holder."}

    entered_pin = str(approval.get("pin", "")).strip()
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == user_id).first()
        expected_pin = getattr(user, "security_pin", "1234") if user else "1234"
        if not entered_pin or entered_pin != expected_pin:
            return {
                "status": "failed",
                "error": "INVALID_PIN",
                "message": "Transaction declined: Incorrect transaction security PIN. Funds were not moved.",
            }

        return banking_service.execute_transfer(
            db=db,
            user_id=user_id,
            from_account_id=from_account_id,
            to_account_id=to_account_id,
            amount=amount,
            idempotency_key=idempotency_key,
        )


@tool
def convert_fx(
    from_account_id: str,
    to_account_id: str,
    amount: float,
    config: RunnableConfig,
) -> dict:
    """
    Convert currency between multi-currency pockets (e.g. USD to EUR or GBP).
    Requires explicit user approval and transaction Security PIN before executing the conversion.
    """
    user_id = _get_user_id_from_config(config)
    idempotency_key = f"{user_id}:fx:{from_account_id}:{to_account_id}:{amount}:{uuid.uuid4().hex[:8]}"

    with SessionLocal() as db:
        from_acc = banking_service.get_account(db, user_id, from_account_id)
        to_acc = banking_service.get_account(db, user_id, to_account_id)

    if not from_acc or not to_acc:
        return {"error": "Both source and target accounts must belong to you."}

    approval = interrupt(
        {
            "type": "fx_approval",
            "from_account_id": from_account_id,
            "to_account_id": to_account_id,
            "amount": amount,
            "from_currency": from_acc["currency"],
            "to_currency": to_acc["currency"],
            "require_pin": True,
            "idempotency_key": idempotency_key,
            "prompt": f"Approve FX conversion of {amount:.2f} {from_acc['currency']} into {to_acc['currency']} ({to_acc['name']})? Enter your 4-digit transaction PIN to authorize.",
        }
    )

    if not approval or approval.get("approved") is not True:
        return {"status": "cancelled", "message": "FX conversion was cancelled by user."}

    entered_pin = str(approval.get("pin", "")).strip()
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == user_id).first()
        expected_pin = getattr(user, "security_pin", "1234") if user else "1234"
        if not entered_pin or entered_pin != expected_pin:
            return {
                "status": "failed",
                "error": "INVALID_PIN",
                "message": "Conversion declined: Incorrect transaction security PIN. Currency was not converted.",
            }

        return banking_service.execute_fx_conversion(
            db=db,
            user_id=user_id,
            from_account_id=from_account_id,
            to_account_id=to_account_id,
            amount=amount,
            idempotency_key=idempotency_key,
        )


@tool
def send_swift_wire(
    from_account_id: str,
    recipient_name: str,
    recipient_iban: str,
    swift_code: str,
    amount: float,
    currency: str,
    config: RunnableConfig,
) -> dict:
    """
    Send an international SWIFT wire transfer.
    Subject to strict verification, Human-In-The-Loop approval, and transaction Security PIN.
    """
    user_id = _get_user_id_from_config(config)
    idempotency_key = f"{user_id}:wire:{from_account_id}:{amount}:{swift_code}:{uuid.uuid4().hex[:8]}"

    approval = interrupt(
        {
            "type": "wire_approval",
            "from_account_id": from_account_id,
            "recipient_name": recipient_name,
            "recipient_iban": recipient_iban,
            "swift_code": swift_code,
            "amount": amount,
            "currency": currency,
            "require_pin": True,
            "idempotency_key": idempotency_key,
            "prompt": f"Authorize international SWIFT wire of {amount:.2f} {currency} to {recipient_name} ({swift_code}) + $15.00 wire fee? Enter your 4-digit transaction PIN to authorize.",
        }
    )

    if not approval or approval.get("approved") is not True:
        return {"status": "cancelled", "message": "SWIFT wire transfer rejected or cancelled."}

    entered_pin = str(approval.get("pin", "")).strip()
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == user_id).first()
        expected_pin = getattr(user, "security_pin", "1234") if user else "1234"
        if not entered_pin or entered_pin != expected_pin:
            return {
                "status": "failed",
                "error": "INVALID_PIN",
                "message": "Wire transfer declined: Incorrect transaction security PIN. Wire was not dispatched.",
            }

        return banking_service.execute_swift_wire(
            db=db,
            user_id=user_id,
            from_account_id=from_account_id,
            recipient_name=recipient_name,
            recipient_iban=recipient_iban,
            swift_code=swift_code,
            amount=amount,
            currency=currency,
            idempotency_key=idempotency_key,
        )


@tool
def get_user_cards(config: RunnableConfig) -> dict:
    """List all debit/credit cards, their masked numbers, status, and spending limits."""
    user_id = _get_user_id_from_config(config)
    with SessionLocal() as db:
        return {"cards": banking_service.get_cards(db, user_id)}


@tool
def toggle_card_freeze(card_id: str, config: RunnableConfig) -> dict:
    """Freeze or unfreeze a card instantly to prevent or re-enable transactions."""
    user_id = _get_user_id_from_config(config)
    with SessionLocal() as db:
        return banking_service.toggle_card_freeze(db, user_id, card_id)


@tool
def update_card_spending_limit(card_id: str, limit: float, config: RunnableConfig) -> dict:
    """Update daily/monthly spending limit on a designated card."""
    user_id = _get_user_id_from_config(config)
    with SessionLocal() as db:
        return banking_service.set_card_limit(db, user_id, card_id, limit)


@tool
def get_market_fx_rates() -> dict:
    """Fetch live foreign exchange (FX) market rates for major currency pairs."""
    with SessionLocal() as db:
        return {"rates": banking_service.get_fx_rates(db)}


ALL_TOOLS = [
    check_balances,
    check_transactions,
    transfer_funds,
    convert_fx,
    send_swift_wire,
    get_user_cards,
    toggle_card_freeze,
    update_card_spending_limit,
    get_market_fx_rates,
]

ROUTER_SYSTEM_PROMPT = """You are a smart financial intent router. Classify the user query into ONE label:
- 'ledger': Checking balances, bank statements, or transaction history.
- 'payments': Moving/transferring funds domestically between internal accounts.
- 'cards': Freezing/unfreezing cards, card details, spending limits.
- 'fx_wire': Foreign currency conversion, exchange rates, SWIFT / international wire transfers.
- 'general': Greetings, chit-chat, FAQ, general banking advice.

Respond strictly with ONLY ONE word: ledger, payments, cards, fx_wire, or general."""

AGENT_SYSTEM_PROMPT = """You are an intelligent, precise AI Banking Copilot for an international bank.
- Always use the provided tools to query real account balances, cards, FX rates, and transactions.
- Never guess account balances or fabricate account IDs.
- When performing financial operations (transfers, FX conversions, SWIFT wires), confirm with the user before triggering or clearly explain when an approval prompt is presented.
- Provide crisp, professional, and helpful responses with proper currency symbols and formatted numbers."""


def get_llm():
    api_key = os.getenv("GROQ_API_KEY")
    model_name = os.getenv("AGENT_MODEL",  "openai/gpt-oss-120b")
    return ChatGroq(model=model_name, api_key=api_key, temperature=0, streaming=True)


def router_node(state: BankingState) -> dict:
    llm = get_llm()
    last_msg = state["messages"][-1].content if state["messages"] else ""
    resp = llm.invoke(
        [
            SystemMessage(content=ROUTER_SYSTEM_PROMPT),
            HumanMessage(content=str(last_msg)),
        ]
    )
    label = (resp.content or "general").strip().lower()
    valid_routes = {"ledger", "payments", "cards", "fx_wire", "general"}
    if label not in valid_routes:
        label = "general"
    return {"route": label}


def assistant_node(state: BankingState) -> dict:
    llm_with_tools = get_llm().bind_tools(ALL_TOOLS)
    messages = [SystemMessage(content=AGENT_SYSTEM_PROMPT), *state["messages"]]
    response = llm_with_tools.invoke(messages)
    return {"messages": [response]}


def should_call_tools(state: BankingState) -> Literal["tools", "__end__"]:
    last_message = state["messages"][-1]
    if isinstance(last_message, AIMessage) and getattr(last_message, "tool_calls", None):
        return "tools"
    return "__end__"


def build_banking_agent():
    builder = StateGraph(BankingState)
    builder.add_node("router", router_node)
    builder.add_node("assistant", assistant_node)
    builder.add_node("tools", ToolNode(ALL_TOOLS))

    builder.add_edge(START, "router")
    builder.add_edge("router", "assistant")
    builder.add_conditional_edges("assistant", should_call_tools, {"tools": "tools", "__end__": END})
    builder.add_edge("tools", "assistant")

    checkpointer = InMemorySaver()
    return builder.compile(checkpointer=checkpointer)


banking_agent = build_banking_agent()
