import os
from datetime import datetime, timezone
from typing import Generator
from sqlalchemy import (
    Column,
    DateTime,
    Float,
    ForeignKey,
    String,
    create_engine,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker, Session

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./banking.db")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, nullable=False)
    security_pin = Column(String, default="1234", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    accounts = relationship("Account", back_populates="user", cascade="all, delete-orphan")
    cards = relationship("Card", back_populates="user", cascade="all, delete-orphan")


class Account(Base):
    __tablename__ = "accounts"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    account_type = Column(String, default="checking")  # checking, savings, currency_pocket
    balance = Column(Float, default=0.0, nullable=False)
    currency = Column(String(3), default="USD", nullable=False)
    iban = Column(String, nullable=True)
    status = Column(String, default="active")  # active, frozen, closed

    user = relationship("User", back_populates="accounts")
    transactions = relationship("Transaction", back_populates="account", cascade="all, delete-orphan")
    cards = relationship("Card", back_populates="account")


class Card(Base):
    __tablename__ = "cards"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    account_id = Column(String, ForeignKey("accounts.id"), nullable=False)
    card_number = Column(String, nullable=False)  # masked e.g. **** **** **** 4821
    cardholder_name = Column(String, nullable=False)
    expiry = Column(String, nullable=False)  # MM/YY
    cvv = Column(String, nullable=False)
    card_type = Column(String, default="physical")  # physical, virtual
    brand = Column(String, default="Visa")  # Visa, Mastercard
    status = Column(String, default="active")  # active, frozen, cancelled
    spending_limit = Column(Float, default=2000.0)
    currency = Column(String(3), default="USD")

    user = relationship("User", back_populates="cards")
    account = relationship("Account", back_populates="cards")


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    account_id = Column(String, ForeignKey("accounts.id"), nullable=False, index=True)
    merchant = Column(String, nullable=False)
    category = Column(String, default="General")  # Shopping, Transport, Dining, FX, Transfer, Wire, Income
    amount = Column(Float, nullable=False)  # Negative for debit, positive for credit
    currency = Column(String(3), default="USD", nullable=False)
    status = Column(String, default="posted")  # posted, pending, failed
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    account = relationship("Account", back_populates="transactions")


class WireTransfer(Base):
    __tablename__ = "wire_transfers"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    from_account_id = Column(String, ForeignKey("accounts.id"), nullable=False)
    recipient_name = Column(String, nullable=False)
    recipient_iban = Column(String, nullable=False)
    swift_code = Column(String, nullable=False)
    amount = Column(Float, nullable=False)
    currency = Column(String(3), nullable=False)
    fee = Column(Float, default=15.0)
    status = Column(String, default="completed")  # completed, pending_review, cancelled
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class FXRate(Base):
    __tablename__ = "fx_rates"

    pair = Column(String, primary_key=True, index=True)  # e.g. "EUR/USD", "USD/EUR"
    rate = Column(Float, nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def seed_initial_data(db: Session) -> None:
    """Populates default users, accounts, cards, FX rates, and transactions if missing."""
    if db.query(User).first():
        return  # Already seeded

    # Seed Users
    user1 = User(id="user_1", name="Alex Morgan", email="alex.morgan@fintech.io")
    user2 = User(id="user_2", name="Sarah Connor", email="sarah.connor@sky.net")
    db.add_all([user1, user2])

    # Seed Accounts for User 1 (Multi-currency portfolio)
    acc1_1 = Account(
        id="chk_101",
        user_id="user_1",
        name="Everyday Checking",
        account_type="checking",
        balance=5420.50,
        currency="USD",
        iban="US33CHAS02001928472910",
        status="active",
    )
    acc1_2 = Account(
        id="sav_102",
        user_id="user_1",
        name="High-Yield Global Vault",
        account_type="savings",
        balance=18500.00,
        currency="USD",
        iban="US88CITI04009182736455",
        status="active",
    )
    acc1_3 = Account(
        id="eur_103",
        user_id="user_1",
        name="Euro Travel Pocket",
        account_type="currency_pocket",
        balance=3200.00,
        currency="EUR",
        iban="DE89370400440532013000",
        status="active",
    )
    acc1_4 = Account(
        id="gbp_104",
        user_id="user_1",
        name="British Pounds Pocket",
        account_type="currency_pocket",
        balance=1450.00,
        currency="GBP",
        iban="GB29BARC20201555555555",
        status="active",
    )

    # Seed Accounts for User 2
    acc2_1 = Account(
        id="chk_201",
        user_id="user_2",
        name="Personal Checking",
        account_type="checking",
        balance=2450.00,
        currency="USD",
        iban="US12BOFA09001122334455",
        status="active",
    )
    acc2_2 = Account(
        id="sav_202",
        user_id="user_2",
        name="Rainy Day Savings",
        account_type="savings",
        balance=6700.00,
        currency="USD",
        iban="US44WELL08009988776655",
        status="active",
    )
    db.add_all([acc1_1, acc1_2, acc1_3, acc1_4, acc2_1, acc2_2])

    # Seed Cards
    card1 = Card(
        id="card_901",
        user_id="user_1",
        account_id="chk_101",
        card_number="**** **** **** 4821",
        cardholder_name="ALEX MORGAN",
        expiry="09/28",
        cvv="742",
        card_type="physical",
        brand="Visa",
        status="active",
        spending_limit=3000.00,
        currency="USD",
    )
    card2 = Card(
        id="card_902",
        user_id="user_1",
        account_id="eur_103",
        card_number="**** **** **** 1094",
        cardholder_name="ALEX MORGAN",
        expiry="12/27",
        cvv="193",
        card_type="virtual",
        brand="Mastercard",
        status="active",
        spending_limit=1000.00,
        currency="EUR",
    )
    db.add_all([card1, card2])

    # Seed FX Rates
    rates = [
        FXRate(pair="EUR/USD", rate=1.09),
        FXRate(pair="USD/EUR", rate=0.9174),
        FXRate(pair="GBP/USD", rate=1.28),
        FXRate(pair="USD/GBP", rate=0.7812),
        FXRate(pair="USD/JPY", rate=154.50),
        FXRate(pair="JPY/USD", rate=0.00647),
        FXRate(pair="USD/CAD", rate=1.36),
        FXRate(pair="CAD/USD", rate=0.7353),
        FXRate(pair="EUR/GBP", rate=0.8515),
        FXRate(pair="GBP/EUR", rate=1.1744),
    ]
    db.add_all(rates)

    # Seed Initial Transactions for User 1
    txs = [
        Transaction(
            id="tx_1",
            user_id="user_1",
            account_id="chk_101",
            merchant="Apple Store Fifth Ave",
            category="Shopping",
            amount=-129.00,
            currency="USD",
            status="posted",
        ),
        Transaction(
            id="tx_2",
            user_id="user_1",
            account_id="chk_101",
            merchant="Whole Foods Market",
            category="Groceries",
            amount=-84.50,
            currency="USD",
            status="posted",
        ),
        Transaction(
            id="tx_3",
            user_id="user_1",
            account_id="chk_101",
            merchant="Global Tech Corp Payroll",
            category="Income",
            amount=4200.00,
            currency="USD",
            status="posted",
        ),
        Transaction(
            id="tx_4",
            user_id="user_1",
            account_id="eur_103",
            merchant="Lufthansa Flight Berlin",
            category="Travel",
            amount=-380.00,
            currency="EUR",
            status="posted",
        ),
        Transaction(
            id="tx_5",
            user_id="user_1",
            account_id="gbp_104",
            merchant="Pret A Manger London",
            category="Dining",
            amount=-14.20,
            currency="GBP",
            status="posted",
        ),
    ]
    db.add_all(txs)
    db.commit()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        seed_initial_data(db)
