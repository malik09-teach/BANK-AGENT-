import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session

from app.database import (
    Account,
    Card,
    FXRate,
    Transaction,
    User,
    WireTransfer,
)

# In-memory idempotency cache for transfers, conversions, and wires
_IDEMPOTENCY_STORE: Dict[str, dict] = {}


class BankingService:
    """
    Deterministic core banking service layer.
    All balance checks, FX calculations, SWIFT wire validation, and ledger mutations live here.
    """

    @staticmethod
    def get_accounts(db: Session, user_id: str) -> List[Dict[str, Any]]:
        accounts = db.query(Account).filter(Account.user_id == user_id).all()
        return [
            {
                "account_id": acc.id,
                "name": acc.name,
                "account_type": acc.account_type,
                "balance": acc.balance,
                "currency": acc.currency,
                "iban": acc.iban,
                "status": acc.status,
            }
            for acc in accounts
        ]

    @staticmethod
    def get_account(db: Session, user_id: str, account_id: str) -> Optional[Dict[str, Any]]:
        acc = db.query(Account).filter(Account.id == account_id, Account.user_id == user_id).first()
        if not acc:
            return None
        return {
            "account_id": acc.id,
            "name": acc.name,
            "account_type": acc.account_type,
            "balance": acc.balance,
            "currency": acc.currency,
            "iban": acc.iban,
            "status": acc.status,
        }

    @staticmethod
    def get_transactions(
        db: Session,
        user_id: str,
        limit: int = 15,
        account_id: Optional[str] = None,
        category: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        query = db.query(Transaction).filter(Transaction.user_id == user_id)
        if account_id:
            query = query.filter(Transaction.account_id == account_id)
        if category:
            query = query.filter(Transaction.category.ilike(f"%{category}%"))

        txs = query.order_by(Transaction.created_at.desc()).limit(limit).all()
        return [
            {
                "tx_id": tx.id,
                "account_id": tx.account_id,
                "merchant": tx.merchant,
                "category": tx.category,
                "amount": tx.amount,
                "currency": tx.currency,
                "status": tx.status,
                "created_at": tx.created_at.isoformat() if tx.created_at else None,
            }
            for tx in txs
        ]

    @staticmethod
    def get_fx_rates(db: Session) -> Dict[str, float]:
        rates = db.query(FXRate).all()
        return {r.pair: r.rate for r in rates}

    @staticmethod
    def get_rate(db: Session, from_currency: str, to_currency: str) -> float:
        if from_currency == to_currency:
            return 1.0
        pair = f"{from_currency}/{to_currency}"
        rate_record = db.query(FXRate).filter(FXRate.pair == pair).first()
        if rate_record:
            return rate_record.rate

        # Try reverse pair
        reverse_pair = f"{to_currency}/{from_currency}"
        rev = db.query(FXRate).filter(FXRate.pair == reverse_pair).first()
        if rev and rev.rate > 0:
            return round(1.0 / rev.rate, 6)

        # Fallback via USD
        to_usd = 1.0 if from_currency == "USD" else (1.0 / (db.query(FXRate).filter(FXRate.pair == f"USD/{from_currency}").first().rate or 1.0))
        from_usd = 1.0 if to_currency == "USD" else (db.query(FXRate).filter(FXRate.pair == f"USD/{to_currency}").first().rate or 1.0)
        return round(to_usd * from_usd, 6)

    @staticmethod
    def execute_transfer(
        db: Session,
        user_id: str,
        from_account_id: str,
        to_account_id: str,
        amount: float,
        idempotency_key: str,
    ) -> Dict[str, Any]:
        if idempotency_key in _IDEMPOTENCY_STORE:
            return _IDEMPOTENCY_STORE[idempotency_key]

        if amount <= 0 or amount > 10000:
            raise ValueError("Transfer amount must be greater than 0 and at most 10,000.")

        if from_account_id == to_account_id:
            raise ValueError("Source and destination accounts must be distinct.")

        source = db.query(Account).filter(Account.id == from_account_id).first()
        if not source or source.user_id != user_id:
            raise PermissionError(f"Source account '{from_account_id}' not found or not owned by user.")

        if source.status != "active":
            raise ValueError(f"Source account '{source.name}' is currently {source.status}.")

        dest = db.query(Account).filter(Account.id == to_account_id).first()
        if not dest:
            raise ValueError(f"Destination account '{to_account_id}' does not exist.")

        if source.balance < amount:
            raise ValueError(
                f"Insufficient funds in {source.name}. Required: {amount:.2f} {source.currency}, Available: {source.balance:.2f} {source.currency}."
            )

        # Check FX conversion if different currencies
        fx_rate = 1.0
        credit_amount = amount
        if source.currency != dest.currency:
            fx_rate = BankingService.get_rate(db, source.currency, dest.currency)
            credit_amount = round(amount * fx_rate, 2)

        source.balance = round(source.balance - amount, 2)
        dest.balance = round(dest.balance + credit_amount, 2)

        tx_debit_id = f"tx_{uuid.uuid4().hex[:10]}"
        tx_credit_id = f"tx_{uuid.uuid4().hex[:10]}"

        debit_tx = Transaction(
            id=tx_debit_id,
            user_id=user_id,
            account_id=source.id,
            merchant=f"Transfer to {dest.name} ({dest.currency})",
            category="Transfer",
            amount=-amount,
            currency=source.currency,
            status="posted",
        )
        credit_tx = Transaction(
            id=tx_credit_id,
            user_id=dest.user_id,
            account_id=dest.id,
            merchant=f"Transfer from {source.name} ({source.currency})",
            category="Transfer",
            amount=credit_amount,
            currency=dest.currency,
            status="posted",
        )

        db.add_all([debit_tx, credit_tx])
        db.commit()

        msg = (
            f"Successfully transferred {amount:.2f} {source.currency} from {source.name} "
            f"to {dest.name} (credited {credit_amount:.2f} {dest.currency}). "
            f"New {source.name} balance: {source.balance:.2f} {source.currency}."
        )
        res = {
            "status": "completed",
            "tx_id": tx_debit_id,
            "message": msg,
            "from_balance": source.balance,
            "to_balance": dest.balance,
            "credit_amount": credit_amount,
            "currency": dest.currency,
        }
        _IDEMPOTENCY_STORE[idempotency_key] = res
        return res

    @staticmethod
    def execute_fx_conversion(
        db: Session,
        user_id: str,
        from_account_id: str,
        to_account_id: str,
        amount: float,
        idempotency_key: str,
    ) -> Dict[str, Any]:
        if idempotency_key in _IDEMPOTENCY_STORE:
            return _IDEMPOTENCY_STORE[idempotency_key]

        source = db.query(Account).filter(Account.id == from_account_id, Account.user_id == user_id).first()
        dest = db.query(Account).filter(Account.id == to_account_id, Account.user_id == user_id).first()

        if not source or not dest:
            raise ValueError("Both source and destination accounts must belong to the user.")

        if source.currency == dest.currency:
            raise ValueError("FX Conversion requires two accounts with different currencies.")

        if amount <= 0:
            raise ValueError("Conversion amount must be positive.")

        if source.balance < amount:
            raise ValueError(f"Insufficient balance in {source.name} ({source.balance:.2f} {source.currency}).")

        rate = BankingService.get_rate(db, source.currency, dest.currency)
        converted_amount = round(amount * rate, 2)

        source.balance = round(source.balance - amount, 2)
        dest.balance = round(dest.balance + converted_amount, 2)

        tx_id = f"tx_fx_{uuid.uuid4().hex[:8]}"
        debit_tx = Transaction(
            id=tx_id,
            user_id=user_id,
            account_id=source.id,
            merchant=f"FX Conversion to {dest.currency} (@ {rate})",
            category="FX",
            amount=-amount,
            currency=source.currency,
            status="posted",
        )
        credit_tx = Transaction(
            id=f"{tx_id}_c",
            user_id=user_id,
            account_id=dest.id,
            merchant=f"FX Received from {source.currency} (@ {rate})",
            category="FX",
            amount=converted_amount,
            currency=dest.currency,
            status="posted",
        )

        db.add_all([debit_tx, credit_tx])
        db.commit()

        msg = (
            f"Converted {amount:.2f} {source.currency} → {converted_amount:.2f} {dest.currency} "
            f"at rate {rate}. Updated balance: {dest.name} = {dest.balance:.2f} {dest.currency}."
        )
        res = {
            "status": "completed",
            "tx_id": tx_id,
            "rate": rate,
            "converted_amount": converted_amount,
            "message": msg,
        }
        _IDEMPOTENCY_STORE[idempotency_key] = res
        return res

    @staticmethod
    def execute_swift_wire(
        db: Session,
        user_id: str,
        from_account_id: str,
        recipient_name: str,
        recipient_iban: str,
        swift_code: str,
        amount: float,
        currency: str,
        idempotency_key: str,
    ) -> Dict[str, Any]:
        if idempotency_key in _IDEMPOTENCY_STORE:
            return _IDEMPOTENCY_STORE[idempotency_key]

        # SWIFT format validation (8 or 11 alphanumeric characters)
        swift_cleaned = swift_code.strip().upper()
        if not re.match(r"^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$", swift_cleaned):
            raise ValueError(f"Invalid SWIFT/BIC code '{swift_code}'. Must be 8 or 11 alphanumeric characters.")

        # IBAN minimal validation
        iban_cleaned = recipient_iban.replace(" ", "").upper()
        if len(iban_cleaned) < 14:
            raise ValueError(f"Invalid IBAN '{recipient_iban}'. Too short.")

        if amount <= 0 or amount > 50000:
            raise ValueError("Wire transfer amount must be between 1 and 50,000.")

        source = db.query(Account).filter(Account.id == from_account_id, Account.user_id == user_id).first()
        if not source:
            raise PermissionError("Source account not found or access denied.")

        wire_fee = 15.00  # Flat international wire fee
        total_deduction = amount + wire_fee

        if source.balance < total_deduction:
            raise ValueError(
                f"Insufficient funds for wire. Amount: {amount:.2f} + Wire Fee: {wire_fee:.2f} = {total_deduction:.2f} {source.currency}. Available: {source.balance:.2f} {source.currency}."
            )

        source.balance = round(source.balance - total_deduction, 2)

        wire_id = f"wire_{uuid.uuid4().hex[:8]}"
        wire = WireTransfer(
            id=wire_id,
            user_id=user_id,
            from_account_id=source.id,
            recipient_name=recipient_name,
            recipient_iban=iban_cleaned,
            swift_code=swift_cleaned,
            amount=amount,
            currency=currency,
            fee=wire_fee,
            status="completed",
        )

        tx = Transaction(
            id=f"tx_{wire_id}",
            user_id=user_id,
            account_id=source.id,
            merchant=f"SWIFT Wire to {recipient_name} ({swift_cleaned})",
            category="Wire",
            amount=-total_deduction,
            currency=source.currency,
            status="posted",
        )

        db.add_all([wire, tx])
        db.commit()

        msg = (
            f"SWIFT wire transfer of {amount:.2f} {currency} to {recipient_name} ({swift_cleaned}) completed. "
            f"Wire Reference: {wire_id}. Wire fee: ${wire_fee:.2f}. New balance: {source.balance:.2f} {source.currency}."
        )
        res = {
            "status": "completed",
            "wire_id": wire_id,
            "message": msg,
            "fee": wire_fee,
            "new_balance": source.balance,
        }
        _IDEMPOTENCY_STORE[idempotency_key] = res
        return res

    @staticmethod
    def get_cards(db: Session, user_id: str) -> List[Dict[str, Any]]:
        cards = db.query(Card).filter(Card.user_id == user_id).all()
        return [
            {
                "card_id": c.id,
                "account_id": c.account_id,
                "card_number": c.card_number,
                "cardholder_name": c.cardholder_name,
                "expiry": c.expiry,
                "card_type": c.card_type,
                "brand": c.brand,
                "status": c.status,
                "spending_limit": c.spending_limit,
                "currency": c.currency,
            }
            for c in cards
        ]

    @staticmethod
    def toggle_card_freeze(db: Session, user_id: str, card_id: str) -> Dict[str, Any]:
        card = db.query(Card).filter(Card.id == card_id, Card.user_id == user_id).first()
        if not card:
            raise ValueError(f"Card '{card_id}' not found or access denied.")

        card.status = "frozen" if card.status == "active" else "active"
        db.commit()
        return {
            "card_id": card.id,
            "status": card.status,
            "message": f"Card {card.card_number} is now {card.status.upper()}.",
        }

    @staticmethod
    def set_card_limit(db: Session, user_id: str, card_id: str, limit: float) -> Dict[str, Any]:
        if limit < 100 or limit > 50000:
            raise ValueError("Spending limit must be between $100 and $50,000.")

        card = db.query(Card).filter(Card.id == card_id, Card.user_id == user_id).first()
        if not card:
            raise ValueError(f"Card '{card_id}' not found or access denied.")

        card.spending_limit = round(limit, 2)
        db.commit()
        return {
            "card_id": card.id,
            "spending_limit": card.spending_limit,
            "message": f"Spending limit for card {card.card_number} updated to ${card.spending_limit:.2f}.",
        }


banking_service = BankingService()
