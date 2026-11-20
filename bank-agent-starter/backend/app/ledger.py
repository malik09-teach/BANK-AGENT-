from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class Account:
    account_id: str
    user_id: str
    name: str
    balance: float
    currency: str = "USD"


@dataclass
class Transaction:
    tx_id: str
    account_id: str
    merchant: str
    amount: float
    status: str


class MockBankingLedger:
    """
    Deterministic banking service layer.
    All ownership checks, balance checks, and ledger mutations live here—not in the LLM.
    """

    def __init__(self) -> None:
        self.accounts: Dict[str, Account] = {
            "chk_101": Account("chk_101", "user_1", "Everyday Checking", 4250.00),
            "sav_102": Account("sav_102", "user_1", "High-Yield Savings", 12800.00),
            "chk_201": Account("chk_201", "user_2", "Personal Checking", 1950.00),
        }
        self.transactions: List[Transaction] = [
            Transaction("tx_1", "chk_101", "Whole Foods Market", -84.50, "posted"),
            Transaction("tx_2", "chk_101", "Metro Transit", -12.00, "posted"),
            Transaction("tx_3", "chk_101", "Employer Payroll", 2400.00, "posted"),
            Transaction("tx_4", "chk_201", "Coffee Roasters", -6.25, "posted"),
        ]
        self._idempotency_store: Dict[str, str] = {}

    def get_accounts(self, user_id: str) -> List[dict]:
        return [
            {
                "account_id": acc.account_id,
                "name": acc.name,
                "balance": acc.balance,
                "currency": acc.currency,
            }
            for acc in self.accounts.values()
            if acc.user_id == user_id
        ]

    def get_transactions(self, user_id: str, limit: int = 10) -> List[dict]:
        user_acc_ids = {
            acc.account_id for acc in self.accounts.values() if acc.user_id == user_id
        }
        txs = [tx for tx in self.transactions if tx.account_id in user_acc_ids]
        return [
            {
                "tx_id": tx.tx_id,
                "account_id": tx.account_id,
                "merchant": tx.merchant,
                "amount": tx.amount,
                "status": tx.status,
            }
            for tx in reversed(txs[-limit:])
        ]

    def execute_transfer(
        self,
        user_id: str,
        from_account_id: str,
        to_account_id: str,
        amount: float,
        idempotency_key: str,
    ) -> dict:
        if idempotency_key in self._idempotency_store:
            return {"status": "duplicate_ignored", "message": self._idempotency_store[idempotency_key]}

        if amount <= 0 or amount > 5000:
            raise ValueError("Transfer amount must be greater than $0 and at most $5,000.")

        source = self.accounts.get(from_account_id)
        if not source or source.user_id != user_id:
            raise PermissionError("Source account not found or not owned by user.")

        dest = self.accounts.get(to_account_id)
        if not dest or dest.user_id != user_id:
            raise ValueError("Destination account must be a valid account belonging to the user.")

        if from_account_id == to_account_id:
            raise ValueError("Source and destination accounts must be different.")

        if source.balance < amount:
            raise ValueError(f"Insufficient funds in {source.name} (${source.balance:.2f}).")

        source.balance = round(source.balance - amount, 2)
        dest.balance = round(dest.balance + amount, 2)

        tx_id = f"tx_{len(self.transactions) + 1}"
        self.transactions.append(
            Transaction(
                tx_id=tx_id,
                account_id=from_account_id,
                merchant=f"Transfer to {dest.name}",
                amount=-amount,
                status="posted",
            )
        )

        msg = (
            f"Transferred ${amount:.2f} from {source.name} ({source.account_id}) "
            f"to {dest.name} ({dest.account_id}). New {source.name} balance: ${source.balance:.2f}."
        )
        self._idempotency_store[idempotency_key] = msg
        return {"status": "completed", "tx_id": tx_id, "message": msg}


ledger = MockBankingLedger()
