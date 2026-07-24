import unittest
from types import SimpleNamespace

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from starlette.requests import Request

    from api.auth import (
        AuthSession,
        CreateManagedProfileRequest,
        ProfilePinRequest,
        SwitchBackRequest,
        _primary_login_user_count,
        create_managed_profile,
        delete_managed_profile,
        get_auth_session,
        get_profiles,
        login,
        set_managed_profile_pin,
        switch_back,
        switch_profile,
    )
    from database import Base
    from models import Card, CollectionItem, User
    from services.auth import decode_token, hash_password

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class ManagedCollectorProfileTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        Session = sessionmaker(bind=self.engine)
        self.db = Session()
        self.parent = User(
            username="ben",
            hashed_password=hash_password("secret"),
            role="admin",
            is_active=True,
            login_enabled=True,
        )
        self.db.add(self.parent)
        self.db.commit()
        self.db.refresh(self.parent)
        self.parent_session = AuthSession(self.parent, self.parent, {})

    def tearDown(self):
        self.db.close()

    def request(self):
        return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 1234)})

    def create_child(self, username="oskar"):
        create_managed_profile(
            CreateManagedProfileRequest(username=username, avatar_id=25),
            session=self.parent_session,
            db=self.db,
        )
        return self.db.query(User).filter(User.username == username).one()

    def test_create_managed_profile_is_trainer_without_login(self):
        child = self.create_child()
        self.assertEqual(child.managed_by_user_id, self.parent.id)
        self.assertEqual(child.role, "trainer")
        self.assertFalse(child.login_enabled)
        self.assertEqual(_primary_login_user_count(self.db), 1)

    def test_managed_profile_cannot_log_in_directly(self):
        child = self.create_child()
        child.hashed_password = hash_password("known")
        self.db.commit()

        with self.assertRaises(HTTPException) as exc:
            login(self.request(), SimpleNamespace(username="oskar", password="known"), self.db)
        self.assertEqual(exc.exception.status_code, 401)

    def test_switch_token_preserves_actor_and_uses_child_as_subject(self):
        child = self.create_child()
        response = switch_profile(child.id, session=self.parent_session, db=self.db)
        payload = decode_token(response.access_token)
        self.assertEqual(payload["sub"], str(child.id))
        self.assertEqual(payload["actor_sub"], str(self.parent.id))
        self.assertTrue(payload["profile_switch"])
        self.assertEqual(response.user["role"], "trainer")

    def test_auth_session_rejects_unrelated_delegated_profile(self):
        child = self.create_child()
        response = switch_profile(child.id, session=self.parent_session, db=self.db)
        session = get_auth_session(token=response.access_token, db=self.db)
        self.assertEqual(session.current_user.id, child.id)
        self.assertEqual(session.actor_user.id, self.parent.id)

        stranger = User(
            username="stranger",
            hashed_password=hash_password("x"),
            role="trainer",
            is_active=True,
            login_enabled=False,
        )
        self.db.add(stranger)
        self.db.commit()
        bad_token = response.access_token
        # Move the child out from under the actor after token issuance.
        child.managed_by_user_id = stranger.id
        self.db.commit()
        with self.assertRaises(HTTPException):
            get_auth_session(token=bad_token, db=self.db)

    def test_profile_list_contains_only_actor_and_direct_children(self):
        child = self.create_child()
        other_parent = User(username="misty", hashed_password=hash_password("x"), role="trainer", is_active=True, login_enabled=True)
        self.db.add(other_parent)
        self.db.commit()
        self.db.add(User(username="togepi", hashed_password=hash_password("x"), role="trainer", is_active=True, login_enabled=False, managed_by_user_id=other_parent.id))
        self.db.commit()

        result = get_profiles(session=self.parent_session, db=self.db)
        self.assertEqual({p["id"] for p in result["profiles"]}, {self.parent.id, child.id})

    def test_switch_back_requires_configured_pin(self):
        child = self.create_child()
        set_managed_profile_pin(
            child.id,
            ProfilePinRequest(pin="1234"),
            session=self.parent_session,
            db=self.db,
        )
        self.db.refresh(child)
        child_session = AuthSession(child, self.parent, {"profile_switch": True, "actor_sub": str(self.parent.id)})

        with self.assertRaises(HTTPException) as exc:
            switch_back(self.request(), SwitchBackRequest(pin="9999"), session=child_session)
        self.assertEqual(exc.exception.status_code, 403)

        response = switch_back(self.request(), SwitchBackRequest(pin="1234"), session=child_session)
        payload = decode_token(response.access_token)
        self.assertEqual(payload["sub"], str(self.parent.id))
        self.assertFalse(payload["profile_switch"])

    def test_child_cannot_manage_profiles_while_active(self):
        child = self.create_child()
        child_session = AuthSession(child, self.parent, {"profile_switch": True})
        with self.assertRaises(HTTPException) as exc:
            create_managed_profile(
                CreateManagedProfileRequest(username="oli"),
                session=child_session,
                db=self.db,
            )
        self.assertEqual(exc.exception.status_code, 403)

    def test_delete_profile_removes_its_collection_only(self):
        child = self.create_child()
        card = Card(id="test-1_en", tcg_card_id="test-1", name="Test", lang="en")
        self.db.add(card)
        self.db.flush()
        self.db.add(CollectionItem(card_id=card.id, user_id=child.id, quantity=2, condition="NM", variant="Normal", lang="en"))
        self.db.add(CollectionItem(card_id=card.id, user_id=self.parent.id, quantity=1, condition="NM", variant="Normal", lang="en"))
        self.db.commit()

        delete_managed_profile(
            child.id,
            confirm_username=child.username,
            session=self.parent_session,
            db=self.db,
        )
        self.assertIsNone(self.db.query(User).filter(User.id == child.id).first())
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.user_id == child.id).count(), 0)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.user_id == self.parent.id).count(), 1)


if __name__ == "__main__":
    unittest.main()
