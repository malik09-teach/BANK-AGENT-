from fastapi import Header, HTTPException


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
