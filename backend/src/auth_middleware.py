import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


security = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class UserIdentity:
    tenant_id: str
    object_id: str
    display_name: str

    @property
    def key(self) -> str:
        return f"{self.tenant_id}:{self.object_id}"


def identity_from_claims(claims: dict[str, Any]) -> UserIdentity:
    tenant_id = str(claims.get("tid") or "").strip()
    object_id = str(claims.get("oid") or "").strip()
    if not tenant_id or not object_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The access token does not contain a tenant and user object identity.",
        )
    display_name = str(
        claims.get("name")
        or claims.get("preferred_username")
        or claims.get("email")
        or object_id
    )
    return UserIdentity(
        tenant_id=tenant_id,
        object_id=object_id,
        display_name=display_name,
    )


class EntraTokenValidator:
    def __init__(self) -> None:
        self.tenant_id = os.getenv("AZURE_TENANT_ID", "")
        self.client_id = os.getenv("ENTRA_CLIENT_ID", "")
        self.development_mode = os.getenv("DEVELOPMENT_MODE", "false").lower() == "true"

        if not self.development_mode and (not self.tenant_id or not self.client_id):
            raise RuntimeError(
                "AZURE_TENANT_ID and ENTRA_CLIENT_ID are required when DEVELOPMENT_MODE is false."
            )

        if self.tenant_id:
            self.issuer = f"https://login.microsoftonline.com/{self.tenant_id}/v2.0"
            self.jwks_client = jwt.PyJWKClient(
                f"https://login.microsoftonline.com/{self.tenant_id}/discovery/v2.0/keys",
                cache_keys=True,
            )
        else:
            self.issuer = ""
            self.jwks_client = None

    def validate(self, token: str) -> dict[str, Any]:
        try:
            if self.development_mode:
                return jwt.decode(
                    token,
                    options={
                        "verify_signature": False,
                        "verify_aud": False,
                        "verify_iss": False,
                    },
                    algorithms=["RS256"],
                )

            if self.jwks_client is None:
                raise RuntimeError("Entra signing key client is not configured.")

            signing_key = self.jwks_client.get_signing_key_from_jwt(token)
            return jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=[self.client_id, f"api://{self.client_id}"],
                issuer=self.issuer,
                options={"require": ["exp", "iat", "iss", "aud"]},
            )
        except jwt.PyJWTError as error:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired access token.",
                headers={"WWW-Authenticate": "Bearer"},
            ) from error


@lru_cache(maxsize=1)
def get_token_validator() -> EntraTokenValidator:
    return EntraTokenValidator()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict[str, Any]:
    validator = get_token_validator()
    if credentials is None:
        if validator.development_mode:
            return {
                "name": os.getenv("DEVELOPMENT_USER", "Local Clinician"),
                "oid": "local-development-user",
                "tid": "local-development-tenant",
            }
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return validator.validate(credentials.credentials)