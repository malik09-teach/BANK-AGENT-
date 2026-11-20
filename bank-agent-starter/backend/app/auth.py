from fastapi import Header, HTTPException, Depends
from sqlalchemy.orm import Session
from app.database import get_db, User, Account


def get_current_user_id(authorization: str | None = Header(default=None)) -> str:
    """
    Demo auth dependency.
    In production, verify a signed JWT/OIDC token and extract the verified `sub` claim.
    Never accept `user_id` from the request body or LLM tool arguments.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    if token == "demo-user-1-token":
        return "user_1"
    if token == "demo-user-2-token":
        return "user_2"

    raise HTTPException(status_code=401, detail="Unauthorized token")


def get_current_user(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
) -> User:
    """Retrieves and validates current authenticated user from database."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found in system")
    return user


def verify_account_ownership(db: Session, user_id: str, account_id: str) -> Account:
    """Ensures the specified account exists and is owned by the authenticated user."""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(status_code=404, detail=f"Account '{account_id}' not found.")
    if account.user_id != user_id:
        raise HTTPException(status_code=403, detail="Access denied: You do not own this account.")
    return account
