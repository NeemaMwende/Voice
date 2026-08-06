"""PostgreSQL persistence for recordings.

One table, ``recordings``, holds each transcription result. The nested parts
(speakers, segments, summary, key points, tags) are stored as JSONB so the row
mirrors the frontend's ``Recording`` shape exactly — save it, reload it, and the
UI renders identically. Tables are created automatically on startup.

Connection is read from DATABASE_URL, or assembled from PG_* env vars
(defaults target the local ``voice`` database).
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from sqlalchemy import BigInteger, Integer, Text, create_engine, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def _build_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    user = os.environ.get("PG_USER", "postgres")
    password = os.environ.get("PG_PASSWORD", "12345")
    host = os.environ.get("PG_HOST", "localhost")
    port = os.environ.get("PG_PORT", "5432")
    name = os.environ.get("PG_DB", "voice")
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{name}"


DATABASE_URL = _build_url()

engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    title: Mapped[str] = mapped_column(Text, default="")
    file_name: Mapped[str] = mapped_column(Text, default="")
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[int] = mapped_column(BigInteger, default=0)  # ms since epoch
    duration_sec: Mapped[int] = mapped_column(Integer, default=0)
    transcript: Mapped[str] = mapped_column(Text, default="")
    audio_url: Mapped[str] = mapped_column(Text, default="")
    # Prose account of the business content — the SOP's source text.
    business_summary: Mapped[str] = mapped_column(Text, default="")

    # The generated Standard Operating Procedure, or {} when the user never asked
    # for one — most conversations aren't procedural, so this is empty by design.
    sop: Mapped[Dict[str, Any]] = mapped_column(JSONB, default=dict)

    speakers: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    segments: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    summary: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    key_points: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    action_items: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    insights: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    outline: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    tags: Mapped[List[Any]] = mapped_column(JSONB, default=list)
    peaks: Mapped[List[Any]] = mapped_column(JSONB, default=list)  # waveform envelope 0..1

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to the exact JSON shape the frontend's Recording expects."""
        return {
            "id": self.id,
            "title": self.title,
            "fileName": self.file_name,
            "sizeBytes": self.size_bytes,
            "createdAt": self.created_at,
            "durationSec": self.duration_sec,
            "transcript": self.transcript,
            "businessSummary": self.business_summary or "",
            # null rather than {} when there is no SOP: an empty object is truthy
            # in JavaScript, so {} would make every recording look like it had one.
            "sop": self.sop or None,
            "audioUrl": self.audio_url or None,
            "speakers": self.speakers or [],
            "segments": self.segments or [],
            "summary": self.summary or [],
            "key": self.key_points or [],
            "actionItems": self.action_items or [],
            "insights": self.insights or [],
            "outline": self.outline or [],
            "tags": self.tags or [],
            "peaks": self.peaks or [],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Recording":
        """Build a row from the frontend's Recording JSON."""
        return cls(
            id=str(data["id"]),
            title=data.get("title") or "",
            file_name=data.get("fileName") or "",
            size_bytes=int(data.get("sizeBytes") or 0),
            created_at=int(data.get("createdAt") or 0),
            duration_sec=int(data.get("durationSec") or 0),
            transcript=data.get("transcript") or "",
            business_summary=data.get("businessSummary") or "",
            sop=data.get("sop") or {},
            audio_url=data.get("audioUrl") or "",
            speakers=data.get("speakers") or [],
            segments=data.get("segments") or [],
            summary=data.get("summary") or [],
            key_points=data.get("key") or [],
            action_items=data.get("actionItems") or [],
            insights=data.get("insights") or [],
            outline=data.get("outline") or [],
            tags=data.get("tags") or [],
            peaks=data.get("peaks") or [],
        )


def _column_type(conn, name: str) -> Optional[str]:
    """Current data_type of a recordings column, or None if it doesn't exist."""
    row = conn.execute(
        text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_name = 'recordings' AND column_name = :n"
        ),
        {"n": name},
    ).first()
    return row[0] if row else None


# Columns with a non-list shape (or added after the list columns shipped),
# with the DDL to backfill them. ``create_all`` only creates missing *tables*,
# so existing installs need these filled in explicitly.
_JSON_LIST = "JSONB NOT NULL DEFAULT '[]'::jsonb"
_JSON_OBJECT = "JSONB NOT NULL DEFAULT '{}'::jsonb"
_TEXT = "TEXT NOT NULL DEFAULT ''"

_ADDED_COLUMNS: Dict[str, str] = {
    "action_items": _JSON_LIST,
    "insights": _JSON_LIST,
    "outline": _JSON_LIST,
    "business_summary": _TEXT,
    "sop": _JSON_OBJECT,
}


def init_db() -> None:
    """Create the recordings table if it doesn't already exist.

    ``create_all`` only creates missing *tables* — a recordings table created
    before the JSONB columns existed is silently left with the old schema, and
    every subsequent query fails. The steps below are idempotent, so this
    self-heals that drift on each startup:

      * add the JSONB payload columns (speakers, segments, summary, key_points,
        tags, action_items, insights, outline, peaks)
      * convert legacy column types to the current model's (epoch-ms bigint
        ``created_at``, integer ``duration_sec``)
      * drop legacy columns the current model doesn't manage (source, status,
        updated_at) — they carry no data the app reads and would block inserts
    """
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for col in (
            "speakers",
            "segments",
            "summary",
            "key_points",
            "tags",
            "action_items",
            "insights",
            "outline",
            "peaks",
        ):
            conn.execute(
                text(
                    f"ALTER TABLE recordings ADD COLUMN IF NOT EXISTS {col} "
                    "JSONB NOT NULL DEFAULT '[]'::jsonb"
                )
            )
        for column, ddl in _ADDED_COLUMNS.items():
            conn.execute(
                text(
                    f"ALTER TABLE recordings ADD COLUMN IF NOT EXISTS {column} {ddl}"
                )
            )
        if _column_type(conn, "created_at") == "timestamp with time zone":
            # The legacy column carries a `DEFAULT now()` which cannot be cast
            # to bigint; the current model has no server default, so drop it.
            conn.execute(
                text("ALTER TABLE recordings ALTER COLUMN created_at DROP DEFAULT")
            )
            conn.execute(
                text(
                    "ALTER TABLE recordings ALTER COLUMN created_at TYPE BIGINT "
                    "USING (EXTRACT(EPOCH FROM created_at) * 1000)::bigint"
                )
            )
        if _column_type(conn, "duration_sec") == "numeric":
            conn.execute(
                text(
                    "ALTER TABLE recordings ALTER COLUMN duration_sec "
                    "TYPE INTEGER USING duration_sec::integer"
                )
            )
        for col in ("source", "status", "updated_at"):
            conn.execute(text(f"ALTER TABLE recordings DROP COLUMN IF EXISTS {col}"))
