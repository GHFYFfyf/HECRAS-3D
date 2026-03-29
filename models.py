from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    Float,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False, index=True)
    crs: Mapped[str] = mapped_column(String(64), nullable=False)
    tif_path: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    hdf_path: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    thumbnail_path: Mapped[str | None] = mapped_column(String(500), nullable=True, default=None)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    cell_center_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    bed_elevation_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    water_surface_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    face_point_coordinate_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    face_point_indexes_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    face_velocity_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    time_axis_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    time_label_ref: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        default=None,
    )
    bbox_minx: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    bbox_miny: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    bbox_maxx: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    bbox_maxy: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    terrain_nodata: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    cell_count: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    face_count: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    time_step_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    file_mtime_hdf: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )
    file_mtime_tif: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )
    indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
