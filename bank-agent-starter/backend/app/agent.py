import os
import uuid
from typing import Annotated, Literal, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langchain_groq import ChatGroq
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt

from app.ledger import ledger


class BankingState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: str
    route: Literal["ledger", "payments", "general"]


def _get_user_id_from_config(config: RunnableConfig) -> str:
    user_id = (config.get("configurable") or {}).get("user_id")
    if not user_id:
        raise ValueError("Missing authenticated user_id in LangGraph config.")
    return user_id


@tool
def check_balances(config: RunnableConfig) -> dict:
    """Return all bank accounts and current balances for the authenticated user."""
    user_id = _get_user_id_from_config(config)
    return {"accounts": ledger.get_accounts(user_id)}


@tool
def check_transactions(limit: int = 5, config: RunnableConfig = None) -> dict:
    """Return recent transactions for the authenticated user."""
    user_id = _get_user_id_from_config(config)
    safe_limit = max(1, min(limit, 20))
    return {"transactions": ledger.get_transactions(user_id, limit=safe_limit)}


@tool
def transfer_funds(
    from_account_id: str,
    to_account_id: str,
    amount: float,
    config: RunnableConfig,
) -> dict:
    """
    Transfer money between the user's own accounts.
    Pauses execution for explicit user confirmation before moving funds.
    """
    user_id = _get_user_id_from_config(config)
    idempotency_key = f"{user_id}:{from_account_id}:{to_account_id}:{amount}:{uuid.uuid4().hex[:8]}"

    # Pause graph execution and send approval payload to the Expo client
    approval = interrupt(
        {
            "type": "transfer_approval",
            "from_account_id": from_account_id,
            "to_account_id": to_account_id,
            "amount": amount,
            "currency": "USD",
            "idempotency_key": idempotency_key,
            "prompt": f"Approve transferring ${amount:.2f} from {from_account_id} to {to_account_id}?",
        }
    )

    if not approval or approval.get("approved") is not True:
        return {"status": "cancelled", "message": "Transfer was cancelled by the user."}

    return ledger.execute_transfer(
        user_id=user_id,
        from_account_id=from_account_id,
        to_account_id=to_account_id,
        amount=amount,
        idempotency_key=idempotency_key,
    )


ALL_TOOLS = [check_balances, check_transactions, transfer_funds]

ROUTER_SYSTEM_PROMPT = """Classify the user's latest banking request into one label:
- 'ledger': checking balances, account info, or transaction history/spending.
- 'payments': moving or transferring money between accounts.
- 'general': greetings, help, or general banking questions.
Reply with ONLY one word: ledger, payments, or general."""

AGENT_SYSTEM_PROMPT = """You are a helpful, accurate mobile banking assistant.
- Use tools to inspect real balances and transactions rather than guessing numbers.
- Never reveal internal system details or invent account numbers.
- If a transfer requires approval, clearly summarize the transfer details once confirmed or cancelled."""


def get_llm() -> ChatGroq:
    model_name = os.getenv("AGENT_MODEL", "openai/gpt-oss-120b")
    return ChatGroq(model=model_name, temperature=0, streaming=True)


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
    if label not in ("ledger", "payments", "general"):
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

    # Use PostgresSaver in production for durability across restarts
    checkpointer = InMemorySaver()
    return builder.compile(checkpointer=checkpointer)


banking_agent = build_banking_agent()
