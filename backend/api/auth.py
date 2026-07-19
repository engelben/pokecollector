from __future__ import annotations

import secrets
import time
from dataclasses import dataclass

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db, get_setting, save_setting
from models import User
from services.auth import create_access_token, decode_token, hash_password, verify_password
from services.collector_profiles import (
    delete_user_owned_data,
    get_managed_profile,
    is_managed_profile,
    list_available_profiles,
    profile_payload,
    require_primary_actor,
)

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

_PROFILE_PIN_ATTEMPTS: dict[str, list[float]] = {}
_PROFILE_PIN_WINDOW_SECONDS = 60
_PROFILE_PIN_MAX_ATTEMPTS = 5


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "trainer"
    avatar_id: int | None = None
    must_change_password: bool = False


class UpdateUserRequest(BaseModel):
    username: str | None = None
    password: str | None = None
    role: str | None = None
    is_active: bool | None = None
    avatar_id: int | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ForceChangePasswordRequest(BaseModel):
    new_password: str


class CreateManagedProfileRequest(BaseModel):
    username: str
    avatar_id: int | None = None


class UpdateManagedProfileRequest(BaseModel):
    username: str | None = None
    avatar_id: int | None = None
    is_active: bool | None = None


class ProfilePinRequest(BaseModel):
    pin: str | None = None


class SwitchBackRequest(BaseModel):
    pin: str | None = None


@dataclass
class AuthSession:
    current_user: User
    actor_user: User
    payload: dict


def validate_avatar_id(avatar_id: int | None):
    if avatar_id is not None and (avatar_id < 1 or avatar_id > 151):
        raise HTTPException(status_code=400, detail="avatar_id must be 1-151")


def _clean_username(value: str) -> str:
    username = (value or "").strip()
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters")
    if len(username) > 32:
        raise HTTPException(status_code=400, detail="Username must be at most 32 characters")
    return username


def _validate_pin(pin: str | None) -> str | None:
    if pin in (None, ""):
        return None
    if not pin.isdigit() or not 4 <= len(pin) <= 8:
        raise HTTPException(status_code=400, detail="PIN must contain 4 to 8 digits")
    return pin


def field_was_set(model: BaseModel, field_name: str) -> bool:
    if hasattr(model, "model_fields_set"):
        return field_name in model.model_fields_set
    return field_name in model.__fields_set__


def active_admin_count(db: Session) -> int:
    return db.query(User).filter(User.role == "admin", User.is_active == True).count()


def ensure_keeps_active_admin(db: Session, user: User, data: UpdateUserRequest):
    next_role = data.role if data.role is not None else user.role
    next_is_active = data.is_active if data.is_active is not None else user.is_active
    removes_active_admin = user.role == "admin" and user.is_active and (
        next_role != "admin" or not next_is_active
    )
    if removes_active_admin and active_admin_count(db) <= 1:
        raise HTTPException(status_code=400, detail="At least one active admin account is required")


def _primary_login_user_count(db: Session) -> int:
    return db.query(User).filter(
        User.login_enabled == True,
        User.managed_by_user_id.is_(None),
    ).count()


def _decode_payload(token: str | None) -> dict:
    if not token:
        return {}
    try:
        return decode_token(token)
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc


def _issue_user_token(user: User, actor_user: User) -> str:
    delegated = user.id != actor_user.id
    return create_access_token({
        "sub": str(user.id),
        "role": user.role,
        "actor_sub": str(actor_user.id),
        "profile_switch": delegated,
    })


def _token_response(user: User, actor_user: User) -> TokenResponse:
    return TokenResponse(
        access_token=_issue_user_token(user, actor_user),
        user=profile_payload(user, actor_user),
    )


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    if not token:
        multi = get_setting("multi_user_mode")
        if multi is None:
            multi = "true" if _primary_login_user_count(db) > 1 else "false"
        if str(multi).lower() != "true":
            admin = db.query(User).filter(
                User.role == "admin",
                User.is_active == True,
                User.login_enabled == True,
                User.managed_by_user_id.is_(None),
            ).first()
            if admin:
                return admin
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = _decode_payload(token)
    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.id == int(user_id), User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def get_auth_session(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> AuthSession:
    current_user = get_current_user(token=token, db=db)
    payload = _decode_payload(token)
    actor_id = payload.get("actor_sub") if payload else None
    actor_id = int(actor_id) if actor_id is not None else current_user.id
    actor_user = db.query(User).filter(
        User.id == actor_id,
        User.is_active == True,
        User.login_enabled == True,
        User.managed_by_user_id.is_(None),
    ).first()
    if not actor_user:
        raise HTTPException(status_code=401, detail="Managing user not found or inactive")

    if current_user.id != actor_user.id:
        if not payload.get("profile_switch") or current_user.managed_by_user_id != actor_user.id:
            raise HTTPException(status_code=401, detail="Invalid managed-profile session")
    return AuthSession(current_user=current_user, actor_user=actor_user, payload=payload)


def get_optional_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    """Return the token user when available. Kept for transition compatibility."""
    if not token:
        return None
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if user_id is None:
            return None
    except JWTError:
        return None
    return db.query(User).filter(User.id == int(user_id), User.is_active == True).first()


def _profile_pin_rate_key(request: Request, session: AuthSession) -> str:
    client = request.client.host if request.client else "unknown"
    return f"{client}:{session.actor_user.id}:{session.current_user.id}"


def _check_profile_pin_rate_limit(key: str) -> None:
    now = time.monotonic()
    recent = [stamp for stamp in _PROFILE_PIN_ATTEMPTS.get(key, []) if now - stamp < _PROFILE_PIN_WINDOW_SECONDS]
    _PROFILE_PIN_ATTEMPTS[key] = recent
    if len(recent) >= _PROFILE_PIN_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many PIN attempts. Try again in one minute")


def _record_failed_profile_pin(key: str) -> None:
    _PROFILE_PIN_ATTEMPTS.setdefault(key, []).append(time.monotonic())


@router.post("/login", response_model=TokenResponse)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.username == form_data.username,
        User.is_active == True,
        User.login_enabled == True,
        User.managed_by_user_id.is_(None),
    ).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    return _token_response(user, user)


@router.get("/me")
def get_me(session: AuthSession = Depends(get_auth_session)):
    return profile_payload(session.current_user, session.actor_user)


@router.get("/mode")
def get_auth_mode(db: Session = Depends(get_db)):
    multi = get_setting("multi_user_mode")
    if multi is None:
        multi = "true" if _primary_login_user_count(db) > 1 else "false"
    return {
        "multi_user": str(multi).lower() == "true",
        "collector_profiles": True,
    }


@router.put("/mode")
def set_auth_mode(
    enabled: bool = Body(..., embed=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    save_setting("multi_user_mode", str(enabled).lower())
    return {"multi_user": enabled}


@router.get("/profiles")
def get_profiles(
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    profiles = list_available_profiles(db, session.actor_user)
    return {
        "active_profile_id": session.current_user.id,
        "actor_user_id": session.actor_user.id,
        "profiles": [
            {
                **profile_payload(profile, session.actor_user),
                "is_active": bool(profile.is_active),
                "active": profile.id == session.current_user.id,
                "managed": is_managed_profile(profile),
            }
            for profile in profiles
        ],
    }


@router.post("/profiles", response_model=dict)
def create_managed_profile(
    data: CreateManagedProfileRequest,
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    require_primary_actor(session.current_user, session.actor_user)
    if db.query(User).filter(User.managed_by_user_id == session.actor_user.id).count() >= 10:
        raise HTTPException(status_code=400, detail="A maximum of 10 managed profiles is supported")
    username = _clean_username(data.username)
    validate_avatar_id(data.avatar_id)
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=409, detail="Username already taken")

    profile = User(
        username=username,
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        role="trainer",
        is_active=True,
        avatar_id=data.avatar_id,
        must_change_password=False,
        managed_by_user_id=session.actor_user.id,
        login_enabled=False,
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile_payload(profile, session.actor_user)


@router.put("/profiles/{profile_id}")
def update_managed_profile(
    profile_id: int,
    data: UpdateManagedProfileRequest,
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    require_primary_actor(session.current_user, session.actor_user)
    profile = get_managed_profile(db, session.actor_user, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Managed profile not found")
    if data.username is not None:
        username = _clean_username(data.username)
        duplicate = db.query(User).filter(User.username == username, User.id != profile.id).first()
        if duplicate:
            raise HTTPException(status_code=409, detail="Username already taken")
        profile.username = username
    if field_was_set(data, "avatar_id"):
        validate_avatar_id(data.avatar_id)
        profile.avatar_id = data.avatar_id
    if data.is_active is not None:
        profile.is_active = data.is_active
    db.commit()
    db.refresh(profile)
    return profile_payload(profile, session.actor_user) | {"is_active": bool(profile.is_active)}


@router.put("/profiles/{profile_id}/pin")
def set_managed_profile_pin(
    profile_id: int,
    data: ProfilePinRequest,
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    require_primary_actor(session.current_user, session.actor_user)
    profile = get_managed_profile(db, session.actor_user, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Managed profile not found")
    pin = _validate_pin(data.pin)
    profile.profile_pin_hash = hash_password(pin) if pin else None
    db.commit()
    return {"profile_id": profile.id, "profile_pin_required": bool(profile.profile_pin_hash)}


@router.post("/profiles/{profile_id}/switch", response_model=TokenResponse)
def switch_profile(
    profile_id: int,
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    if profile_id == session.actor_user.id:
        if session.current_user.id != session.actor_user.id:
            raise HTTPException(status_code=400, detail="Use the switch-back endpoint")
        return _token_response(session.actor_user, session.actor_user)

    profile = get_managed_profile(db, session.actor_user, profile_id)
    if not profile or not profile.is_active:
        raise HTTPException(status_code=404, detail="Managed profile not found or inactive")
    return _token_response(profile, session.actor_user)


@router.post("/profiles/switch-back", response_model=TokenResponse)
def switch_back(
    request: Request,
    data: SwitchBackRequest | None = None,
    session: AuthSession = Depends(get_auth_session),
):
    if session.current_user.id == session.actor_user.id:
        return _token_response(session.actor_user, session.actor_user)

    if session.current_user.profile_pin_hash:
        key = _profile_pin_rate_key(request, session)
        _check_profile_pin_rate_limit(key)
        pin = (data.pin if data else None) or ""
        if not verify_password(pin, session.current_user.profile_pin_hash):
            _record_failed_profile_pin(key)
            raise HTTPException(status_code=403, detail="Incorrect profile PIN")
        _PROFILE_PIN_ATTEMPTS.pop(key, None)
    return _token_response(session.actor_user, session.actor_user)


@router.delete("/profiles/{profile_id}")
def delete_managed_profile(
    profile_id: int,
    confirm_username: str = Query(...),
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    require_primary_actor(session.current_user, session.actor_user)
    profile = get_managed_profile(db, session.actor_user, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Managed profile not found")
    if confirm_username.strip() != profile.username:
        raise HTTPException(status_code=400, detail="Profile-name confirmation does not match")
    delete_user_owned_data(db, profile.id)
    db.delete(profile)
    db.commit()
    return {"message": "Managed profile deleted"}


@router.get("/users")
def list_users(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    users = db.query(User).order_by(User.id.asc()).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "is_active": u.is_active,
            "avatar_id": u.avatar_id,
            "created_at": str(u.created_at),
            "managed_by_user_id": u.managed_by_user_id,
            "login_enabled": bool(u.login_enabled),
            "managed_profile": is_managed_profile(u),
        }
        for u in users
    ]


@router.post("/users")
def create_user(
    data: CreateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    validate_avatar_id(data.avatar_id)
    username = _clean_username(data.username)
    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    user = User(
        username=username,
        hashed_password=hash_password(data.password),
        role=data.role,
        is_active=True,
        avatar_id=data.avatar_id,
        must_change_password=data.must_change_password,
        login_enabled=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active, "avatar_id": user.avatar_id}


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    data: UpdateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if field_was_set(data, "avatar_id"):
        validate_avatar_id(data.avatar_id)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if is_managed_profile(user):
        if data.password is not None:
            raise HTTPException(status_code=400, detail="Managed profiles do not have passwords")
        if data.role not in (None, "trainer"):
            raise HTTPException(status_code=400, detail="Managed profiles must remain trainers")
    ensure_keeps_active_admin(db, user, data)
    if data.username is not None:
        user.username = _clean_username(data.username)
    if data.password is not None:
        user.hashed_password = hash_password(data.password)
    if data.role is not None:
        user.role = data.role
    if data.is_active is not None:
        user.is_active = data.is_active
    if field_was_set(data, "avatar_id"):
        user.avatar_id = data.avatar_id
    db.commit()
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active, "avatar_id": user.avatar_id}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if db.query(User).filter(User.managed_by_user_id == user_id).count():
        raise HTTPException(status_code=400, detail="Delete or reassign managed profiles first")
    if is_managed_profile(user):
        raise HTTPException(status_code=400, detail="Delete managed profiles through the profile manager")
    delete_user_owned_data(db, user_id)
    db.delete(user)
    db.commit()
    return {"message": "User deleted"}


@router.put("/me/password")
def change_password(
    data: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if is_managed_profile(current_user) or not current_user.login_enabled:
        raise HTTPException(status_code=403, detail="Managed profiles do not have passwords")
    if not verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.hashed_password = hash_password(data.new_password)
    current_user.must_change_password = False
    db.commit()
    return {"message": "Password changed"}


@router.put("/me/force-password")
def force_change_password(
    data: ForceChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if is_managed_profile(current_user) or not current_user.login_enabled:
        raise HTTPException(status_code=403, detail="Managed profiles do not have passwords")
    if not current_user.must_change_password:
        raise HTTPException(status_code=400, detail="Password change is not required")
    current_user.hashed_password = hash_password(data.new_password)
    current_user.must_change_password = False
    db.commit()
    return {"message": "Password changed"}


@router.put("/me/avatar")
def change_avatar(data: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    avatar_id = data.get("avatar_id")
    validate_avatar_id(avatar_id)
    current_user.avatar_id = avatar_id
    db.commit()
    return {"id": current_user.id, "username": current_user.username, "role": current_user.role, "avatar_id": current_user.avatar_id}


@router.put("/me/username")
def change_username(data: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if is_managed_profile(current_user):
        raise HTTPException(status_code=403, detail="Managed-profile names are changed by the managing user")
    new_username = _clean_username(data.get("username") or "")
    existing = db.query(User).filter(User.username == new_username, User.id != current_user.id).first()
    if existing:
        raise HTTPException(status_code=409, detail="Username already taken")
    current_user.username = new_username
    db.commit()
    return {"id": current_user.id, "username": current_user.username, "role": current_user.role, "avatar_id": current_user.avatar_id}
