import datetime
import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import SyncLog
    from services.sync_service import (
        FULL_SYNC_STALE_AFTER,
        _full_sync_in_progress,
        perform_full_sync,
    )
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class FullSyncGuardTests(unittest.TestCase):
    """A full sync must skip if another full sync is already running, so two
    overlapping runs cannot race and collide on card primary keys. Stale
    'running' rows (left by a crash/restart) must NOT block forever.
    """

    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False)()

    def _running_full(self, minutes_ago):
        return SyncLog(
            sync_type="full",
            status="running",
            started_at=datetime.datetime.utcnow() - datetime.timedelta(minutes=minutes_ago),
        )

    def test_no_rows_not_in_progress(self):
        self.assertFalse(_full_sync_in_progress(self._db()))

    def test_recent_running_full_blocks(self):
        db = self._db()
        db.add(self._running_full(minutes_ago=1))
        db.commit()
        self.assertTrue(_full_sync_in_progress(db))

    def test_stale_running_full_does_not_block(self):
        db = self._db()
        stale_minutes = int(FULL_SYNC_STALE_AFTER.total_seconds() // 60) + 5
        db.add(self._running_full(minutes_ago=stale_minutes))
        db.commit()
        self.assertFalse(_full_sync_in_progress(db))

    def test_running_price_sync_does_not_block_full(self):
        db = self._db()
        db.add(SyncLog(sync_type="price", status="running", started_at=datetime.datetime.utcnow()))
        db.commit()
        self.assertFalse(_full_sync_in_progress(db))

    def test_finished_full_does_not_block(self):
        db = self._db()
        now = datetime.datetime.utcnow()
        db.add(SyncLog(sync_type="full", status="success", started_at=now, finished_at=now))
        db.commit()
        self.assertFalse(_full_sync_in_progress(db))

    def test_perform_full_sync_skips_without_new_row_or_network(self):
        # A recent running full sync exists -> perform_full_sync must short-circuit
        # BEFORE creating its own log row or doing any network work.
        db = self._db()
        db.add(self._running_full(minutes_ago=1))
        db.commit()
        before = db.query(SyncLog).count()
        result = perform_full_sync(db)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(db.query(SyncLog).count(), before)


if __name__ == "__main__":
    unittest.main()
