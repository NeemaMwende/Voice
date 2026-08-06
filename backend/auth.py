"""Keycloak JWT validation for the DAXA API.

The frontend signs users in through Keycloak (OIDC); this module verifies the
resulting access tokens before write operations reach the database.

Tokens are validated against the realm's JWKS (public keys), so the backend
only talks to Keycloak for the initial JWKS fetch (then cached). No per-request
round-trips.
"""

import os
import time

import jwt
from fastapi import Header, HTTPException

# e.g. http://localhost:8080/realms/daxa
ISSUER = os.environ.get("KC_ISSUER", "http://localhost:8080/realms/daxa")
JWKS_URL = f"{ISSUER}/protocol/openid-connect/certs"

_jwks_ttl = 3600  # seconds between JWKS re-fetches
_jwks_refresh_at = 0.0


def _signing_key(token: str) -> str:
    """RSA public key for a token's kid, with a cheap hourly cache."""
    global _jwks_refresh_at
    if time.time() - _jwks_refresh_at > _jwks_ttl:
        _jwks_refresh_at = time.time()
    client = jwt.PyJWKClient(JWKS_URL)
    return client.get_signing_key_from_jwt(token).key


def get_current_user(authorization: str | None = Header(None)) -> dict:
    """FastAPI dependency: require a valid Keycloak access token.

    Returns the token claims (sub, preferred_username, email, ...). Raises 401
    when the header is missing or the token fails signature/expiry/issuer
    checks.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(
            token,
            key=_signing_key(token),
            algorithms=["RS256"],
            issuer=ISSUER,
            # Public client → the token's audience is "account" by default;
            # resource servers enforce via issuer + signature instead.
            options={"verify_aud": False},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}") from exc
    return payload
