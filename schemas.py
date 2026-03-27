from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class BoundingBox(BaseModel):
    minx: float
    miny: float
    maxx: float
    maxy: float


class ProjectBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    crs: str = Field(min_length=1, max_length=64)
    tif_path: str = Field(min_length=1, max_length=500)
    hdf_path: str = Field(min_length=1, max_length=500)
    thumbnail_path: str | None = Field(default=None, max_length=500)
    summary: str | None = None


class ProjectCreate(ProjectBase):
    pass


class ProjectCheckRequest(BaseModel):
    tif_path: str = Field(min_length=1, max_length=500)
    hdf_path: str = Field(min_length=1, max_length=500)


class ProjectListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    thumbnail_path: str | None
    summary: str | None
    created_at: datetime


class ProjectResponse(ProjectBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    bbox: BoundingBox | None = None
    cell_center_ref: str | None
    bed_elevation_ref: str | None
    water_surface_ref: str | None
    face_point_coordinate_ref: str | None
    face_point_indexes_ref: str | None
    face_velocity_ref: str | None
    time_axis_ref: str | None
    time_label_ref: str | None
    cell_count: int | None
    face_count: int | None
    time_step_count: int
    created_at: datetime
    updated_at: datetime


class TimeAxisResponse(BaseModel):
    project_id: int
    time_step_count: int
    time_axis_ref: str | None
    time_label_ref: str | None


class FrameRequest(BaseModel):
    project_id: int
    data_kind: Literal["water_depth", "velocity"]
    time_index: int = Field(ge=0)
    bbox: BoundingBox | None = None
    max_points: int = Field(default=50000, ge=1, le=500000)
    sampling_mode: str = Field(default="adaptive", max_length=32)
    stride: int | None = Field(default=None, ge=1)
    value_min: float | None = None
    value_max: float | None = None
    include_z: bool = True
    output_mode: str = Field(default="points", max_length=32)


class FrameMetaResponse(BaseModel):
    project_id: int
    data_kind: Literal["water_depth", "velocity"]
    time_index: int
    point_count: int
    encoding: str
    geometry_kind: Literal["cell", "face"]
    crs: str
    bbox: BoundingBox | None
