from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import h5py
import rasterio
from sqlalchemy import select

from database import SessionLocal, engine
from models import Base, Project

PROJECT_NAME = "shuiku"
TIF_PATH = "resource/hdf/shuiku.sk.tif"
HDF_PATH = "resource/hdf/shuiku.p01.hdf"

CELL_CENTER_REF = "Geometry/2D Flow Areas/Perimeter 1/Cells Center Coordinate"
BED_ELEVATION_REF = "Geometry/2D Flow Areas/Perimeter 1/Cells Minimum Elevation"
WATER_SURFACE_REF = (
    "Results/Unsteady/Output/Output Blocks/Base Output/Unsteady Time Series/"
    "2D Flow Areas/Perimeter 1/Water Surface"
)
FACE_POINT_COORDINATE_REF = "Geometry/2D Flow Areas/Perimeter 1/FacePoints Coordinate"
FACE_POINT_INDEXES_REF = "Geometry/2D Flow Areas/Perimeter 1/Faces FacePoint Indexes"
FACE_VELOCITY_REF = (
    "Results/Unsteady/Output/Output Blocks/Base Output/Unsteady Time Series/"
    "2D Flow Areas/Perimeter 1/Face Velocity"
)
TIME_AXIS_REF = "Results/Unsteady/Output/Output Blocks/Base Output/Unsteady Time Series/Time"
TIME_LABEL_REF = (
    "Results/Unsteady/Output/Output Blocks/Base Output/Unsteady Time Series/"
    "Time Date Stamp"
)


def _to_crs_label(src: rasterio.io.DatasetReader) -> str:
    epsg = src.crs.to_epsg() if src.crs else None
    return f"EPSG:{epsg}" if epsg is not None else "UNKNOWN"


def main() -> None:
    root = Path(__file__).resolve().parent
    tif_file = (root / TIF_PATH).resolve()
    hdf_file = (root / HDF_PATH).resolve()

    if not tif_file.exists():
        raise FileNotFoundError(f"TIF file not found: {tif_file}")
    if not hdf_file.exists():
        raise FileNotFoundError(f"HDF file not found: {hdf_file}")

    with rasterio.open(tif_file) as src:
        bounds = src.bounds
        crs = _to_crs_label(src)
        terrain_nodata = src.nodata

    with h5py.File(hdf_file, "r") as hdf:
        if CELL_CENTER_REF not in hdf:
            raise KeyError(f"Missing HDF path: {CELL_CENTER_REF}")
        if WATER_SURFACE_REF not in hdf:
            raise KeyError(f"Missing HDF path: {WATER_SURFACE_REF}")
        if FACE_VELOCITY_REF not in hdf:
            raise KeyError(f"Missing HDF path: {FACE_VELOCITY_REF}")

        cell_count = int(hdf[CELL_CENTER_REF].shape[0])
        face_count = int(hdf[FACE_VELOCITY_REF].shape[1])
        time_step_count = int(hdf[WATER_SURFACE_REF].shape[0])

    now = datetime.now(UTC)
    hdf_mtime = datetime.fromtimestamp(hdf_file.stat().st_mtime, UTC)
    tif_mtime = datetime.fromtimestamp(tif_file.stat().st_mtime, UTC)

    Base.metadata.create_all(bind=engine)

    with SessionLocal() as db:
        project = db.execute(
            select(Project).where(Project.name == PROJECT_NAME)
        ).scalar_one_or_none()

        if project is None:
            project = Project(
                name=PROJECT_NAME,
                crs=crs,
                tif_path=TIF_PATH,
                hdf_path=HDF_PATH,
            )
            db.add(project)

        project.crs = crs
        project.tif_path = TIF_PATH
        project.hdf_path = HDF_PATH

        project.cell_center_ref = CELL_CENTER_REF
        project.bed_elevation_ref = BED_ELEVATION_REF
        project.water_surface_ref = WATER_SURFACE_REF

        project.face_point_coordinate_ref = FACE_POINT_COORDINATE_REF
        project.face_point_indexes_ref = FACE_POINT_INDEXES_REF
        project.face_velocity_ref = FACE_VELOCITY_REF

        project.time_axis_ref = TIME_AXIS_REF
        project.time_label_ref = TIME_LABEL_REF

        project.bbox_minx = bounds.left
        project.bbox_miny = bounds.bottom
        project.bbox_maxx = bounds.right
        project.bbox_maxy = bounds.top

        project.terrain_nodata = terrain_nodata
        project.cell_count = cell_count
        project.face_count = face_count
        project.time_step_count = time_step_count

        project.file_mtime_hdf = hdf_mtime
        project.file_mtime_tif = tif_mtime
        project.indexed_at = now

        db.commit()
        db.refresh(project)

    print("Project inserted/updated successfully")
    print(f"id={project.id}, name={project.name}")
    print(f"tif={project.tif_path}")
    print(f"hdf={project.hdf_path}")
    print(
        f"bbox=({project.bbox_minx}, {project.bbox_miny}, "
        f"{project.bbox_maxx}, {project.bbox_maxy})"
    )
    print(
        f"cell_count={project.cell_count}, face_count={project.face_count}, "
        f"time_step_count={project.time_step_count}"
    )


if __name__ == "__main__":
    main()
