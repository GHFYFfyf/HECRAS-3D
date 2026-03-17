from __future__ import annotations

from datetime import datetime
from pathlib import Path
from threading import Lock
from time import perf_counter
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import h5py
import rasterio
import numpy as np
from rasterio.windows import Window
from sqlalchemy import select
from sqlalchemy.orm import Session

from database import Base, engine, get_db
from models import Project


BASE_DIR = Path(__file__).resolve().parent


_HDF_STATIC_CACHE_LOCK = Lock()
_HDF_STATIC_CACHE: dict[tuple[str, int, str, str, str], dict[str, Any]] = {}


def _get_hdf_static_data(
	hdf_path: Path,
	cell_center_ref: str,
	bed_elevation_ref: str,
	water_surface_ref: str,
) -> dict[str, Any]:
	"""Load and cache HDF datasets that do not change per time index."""
	hdf_stat = hdf_path.stat()
	cache_key = (
		str(hdf_path),
		int(hdf_stat.st_mtime_ns),
		cell_center_ref,
		bed_elevation_ref,
		water_surface_ref,
	)

	with _HDF_STATIC_CACHE_LOCK:
		cached = _HDF_STATIC_CACHE.get(cache_key)
	if cached is not None:
		return cached

	with h5py.File(hdf_path, "r") as hdf:
		if cell_center_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {cell_center_ref}")
		if bed_elevation_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {bed_elevation_ref}")
		if water_surface_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {water_surface_ref}")

		coords = np.asarray(hdf[cell_center_ref][:], dtype=np.float32)
		bed = np.asarray(hdf[bed_elevation_ref][:], dtype=np.float32)
		water_surface_ds = hdf[water_surface_ref]

		if coords.ndim != 2 or coords.shape[1] < 2:
			raise HTTPException(status_code=400, detail="Invalid cell center coordinates shape")
		if bed.ndim != 1:
			raise HTTPException(status_code=400, detail="Invalid bed elevation shape")
		if water_surface_ds.ndim != 2:
			raise HTTPException(status_code=400, detail="Invalid water surface shape")

		cell_count = int(coords.shape[0])
		time_step_count = int(water_surface_ds.shape[0])
		if bed.shape[0] != cell_count or int(water_surface_ds.shape[1]) != cell_count:
			raise HTTPException(status_code=400, detail="Inconsistent HDF dataset sizes")

	static_data = {
		"coords": coords,
		"bed": bed,
		"cell_count": cell_count,
		"time_step_count": time_step_count,
	}

	# Drop stale entries for the same file to keep cache bounded when HDF is updated.
	with _HDF_STATIC_CACHE_LOCK:
		stale_keys = [key for key in _HDF_STATIC_CACHE if key[0] == str(hdf_path) and key != cache_key]
		for stale_key in stale_keys:
			_HDF_STATIC_CACHE.pop(stale_key, None)
		_HDF_STATIC_CACHE[cache_key] = static_data

	return static_data


def _build_square_tile_bounds(
	*,
	width: int,
	height: int,
	valid_count: int,
	target_points_per_tile: int,
) -> tuple[int, list[tuple[int, int, int, int]]]:
	"""Build N x N square tile bounds by valid point count target."""
	target = max(10_000, min(99_999, int(target_points_per_tile)))
	tile_axis_count = max(1, int(np.ceil(np.sqrt(max(valid_count, 1) / target))))
	tile_width = int(np.ceil(width / tile_axis_count))
	tile_height = int(np.ceil(height / tile_axis_count))
	bounds: list[tuple[int, int, int, int]] = []
	for tile_row in range(tile_axis_count):
		row_start = tile_row * tile_height
		row_end = min(height, row_start + tile_height)
		for tile_col in range(tile_axis_count):
			col_start = tile_col * tile_width
			col_end = min(width, col_start + tile_width)
			if row_start >= row_end or col_start >= col_end:
				continue
			bounds.append((row_start, row_end, col_start, col_end))
	return tile_axis_count, bounds

app = FastAPI(title="HEC-RAS 3D Project Manager")
app.mount("/assets", StaticFiles(directory=BASE_DIR / "assets"), name="assets")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@app.on_event("startup")
def on_startup() -> None:
	Base.metadata.create_all(bind=engine)


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
	html_path = BASE_DIR / "templates" / "test.html"
	return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.get("/three", response_class=HTMLResponse)
def three_page() -> HTMLResponse:
	html_path = BASE_DIR / "templates" / "three.html"
	return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.get("/api/projects/cards")
def get_project_cards(
	db: Session = Depends(get_db),
) -> list[dict[str, int | float | str | None]]:
	# Receive: frontend GET /api/projects/cards, no body, used by project card list.
	projects = db.execute(select(Project).order_by(Project.created_at.desc())).scalars().all()
	result: list[dict[str, int | float | str | None]] = []

	for project in projects:
		created = project.created_at
		if isinstance(created, datetime):
			created_at = created.isoformat()
		else:
			created_at = ""

		result.append(
			{
				"id": project.id,
				"name": project.name,
				"created_at": created_at,
				"crs": project.crs,
				"bbox_minx": project.bbox_minx,
				"bbox_miny": project.bbox_miny,
				"bbox_maxx": project.bbox_maxx,
				"bbox_maxy": project.bbox_maxy,
			}
		)

	# Send: card list JSON to frontend assets/js/project-cards.js (fetchProjects).
	return result


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
	# Receive: frontend DELETE /api/projects/{project_id}, path param is the target project id.
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	db.delete(project)
	db.commit()
	# Send: deletion result flag back to frontend assets/js/project-cards.js (deleteProject).
	return {"ok": True}


@app.get("/api/projects/{project_id}/tif-points")
def get_project_tif_points(
	project_id: int,
	max_points: int = Query(default=80000, ge=1000, le=300000),
	db: Session = Depends(get_db),
) -> dict[str, object]:
	# Receive: frontend GET /api/projects/{project_id}/tif-points with project_id + max_points query.
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	tif_path = (BASE_DIR / project.tif_path).resolve()
	if not tif_path.exists():
		raise HTTPException(status_code=404, detail="TIF file not found")

	with rasterio.open(tif_path) as src:
		band = src.read(1, masked=True)
		valid_mask = ~np.ma.getmaskarray(band)
		valid_count = int(valid_mask.sum())

		if valid_count == 0:
			# Send: empty point payload to frontend renderer when tif has no valid cells.
			return {
				"project_id": project_id,
				"metadata": {
					"source": str(project.tif_path),
					"crs": src.crs.to_string() if src.crs else "UNKNOWN",
					"width": int(src.width),
					"height": int(src.height),
					"nodata": src.nodata,
				},
				"point_count": 0,
				"stride": 1,
				"grid": {
					"rows": 0,
					"cols": 0,
				},
				"vertices": [],
				"points": [],
			}

		# Safety guard: full-resolution point return is fine for small projects
		# (e.g. shuiku), but will freeze/oom on very large rasters (e.g. changjiang).
		# Keep no-downsampling behavior for small datasets; fall back to adaptive stride
		# when valid cells are too many.
		FULL_RES_VALID_CELL_LIMIT = 300_000
		if valid_count <= FULL_RES_VALID_CELL_LIMIT:
			stride = 1
		else:
			stride = max(1, int(np.ceil(np.sqrt(valid_count / max_points))))
		sampled_rows = np.arange(0, src.height, stride, dtype=np.int32)
		sampled_cols = np.arange(0, src.width, stride, dtype=np.int32)

		grid_rows, grid_cols = np.meshgrid(sampled_rows, sampled_cols, indexing="ij")
		rows = grid_rows.ravel()
		cols = grid_cols.ravel()

		sample_row_idx, sample_col_idx = np.indices((sampled_rows.size, sampled_cols.size))
		sample_row_flat = sample_row_idx.ravel()
		sample_col_flat = sample_col_idx.ravel()

		valid_flat = valid_mask[rows, cols]
		sampled_band = band[rows, cols].astype(np.float64)
		z_values = np.asarray(np.ma.filled(sampled_band, np.nan), dtype=np.float64)
		x_vals, y_vals = rasterio.transform.xy(src.transform, rows, cols, offset="center")

		vertices = [
			{
				"sample_row": int(sample_row),
				"sample_col": int(sample_col),
				"row": int(row),
				"col": int(col),
				"x": float(x),
				"y": float(y),
				"elevation": float(z) if bool(valid) else None,
				"valid": bool(valid),
			}
			for sample_row, sample_col, row, col, x, y, z, valid in zip(
				sample_row_flat,
				sample_col_flat,
				rows,
				cols,
				x_vals,
				y_vals,
				z_values,
				valid_flat,
				strict=False,
			)
		]

		points = [
			[float(x), float(y), float(z)]
			for x, y, z, valid in zip(x_vals, y_vals, z_values, valid_flat, strict=False)
			if bool(valid)
		]

		# Send: sampled terrain points/vertices JSON to frontend three.js overlay consumers.
		return {
			"project_id": project_id,
			"metadata": {
				"source": str(project.tif_path),
				"crs": src.crs.to_string() if src.crs else "UNKNOWN",
				"width": int(src.width),
				"height": int(src.height),
				"nodata": src.nodata,
			},
			"point_count": len(points),
			"stride": stride,
			"grid": {
				"rows": int(sampled_rows.size),
				"cols": int(sampled_cols.size),
			},
			"vertices": vertices,
			"points": points,
		}


@app.get("/api/projects/{project_id}/tif-tiles")
def get_project_tif_tiles(
	project_id: int,
	target_points_per_tile: int = Query(default=25000, ge=10000, le=99999),
	db: Session = Depends(get_db),
) -> dict[str, object]:
	"""Return uniformly split square tile metadata and tile centers for lazy loading."""
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	tif_path = (BASE_DIR / project.tif_path).resolve()
	if not tif_path.exists():
		raise HTTPException(status_code=404, detail="TIF file not found")

	with rasterio.open(tif_path) as src:
		band = src.read(1, masked=True)
		valid_mask = ~np.ma.getmaskarray(band)
		valid_count = int(valid_mask.sum())
		z_values = np.asarray(np.ma.filled(band.astype(np.float64), np.nan), dtype=np.float64)
		z_min = float(np.nanmin(z_values)) if np.isfinite(np.nanmin(z_values)) else 0.0
		z_max = float(np.nanmax(z_values)) if np.isfinite(np.nanmax(z_values)) else 0.0

		if valid_count == 0:
			return {
				"project_id": project_id,
				"target_points_per_tile": int(target_points_per_tile),
				"tile_grid": {"rows": 0, "cols": 0},
				"tile_count": 0,
				"valid_point_count": 0,
				"metadata": {
					"source": str(project.tif_path),
					"crs": src.crs.to_string() if src.crs else "UNKNOWN",
					"width": int(src.width),
					"height": int(src.height),
					"nodata": src.nodata,
					"bbox_minx": float(src.bounds.left),
					"bbox_miny": float(src.bounds.bottom),
					"bbox_maxx": float(src.bounds.right),
					"bbox_maxy": float(src.bounds.top),
					"z_min": z_min,
					"z_max": z_max,
					"z_mid": float((z_min + z_max) * 0.5),
				},
				"tiles": [],
			}

		tile_axis_count, tile_bounds = _build_square_tile_bounds(
			width=int(src.width),
			height=int(src.height),
			valid_count=valid_count,
			target_points_per_tile=int(target_points_per_tile),
		)

		integral = np.cumsum(np.cumsum(valid_mask.astype(np.int32), axis=0), axis=1)

		def rect_sum(row_start: int, row_end: int, col_start: int, col_end: int) -> int:
			total = int(integral[row_end - 1, col_end - 1])
			if row_start > 0:
				total -= int(integral[row_start - 1, col_end - 1])
			if col_start > 0:
				total -= int(integral[row_end - 1, col_start - 1])
			if row_start > 0 and col_start > 0:
				total += int(integral[row_start - 1, col_start - 1])
			return total

		tiles: list[dict[str, object]] = []
		for tile_index, (row_start, row_end, col_start, col_end) in enumerate(tile_bounds):
			center_row = (row_start + row_end - 1) * 0.5
			center_col = (col_start + col_end - 1) * 0.5
			center_x, center_y = src.transform * (center_col + 0.5, center_row + 0.5)
			tiles.append(
				{
					"tile_id": tile_index,
					"tile_row": int(tile_index // tile_axis_count),
					"tile_col": int(tile_index % tile_axis_count),
					"row_start": int(row_start),
					"row_end": int(row_end),
					"col_start": int(col_start),
					"col_end": int(col_end),
					"center_x": float(center_x),
					"center_y": float(center_y),
					"point_count": int(rect_sum(row_start, row_end, col_start, col_end)),
				}
			)

		return {
			"project_id": project_id,
			"target_points_per_tile": int(target_points_per_tile),
			"tile_grid": {"rows": tile_axis_count, "cols": tile_axis_count},
			"tile_count": len(tiles),
			"valid_point_count": valid_count,
			"metadata": {
				"source": str(project.tif_path),
				"crs": src.crs.to_string() if src.crs else "UNKNOWN",
				"width": int(src.width),
				"height": int(src.height),
				"nodata": src.nodata,
				"bbox_minx": float(src.bounds.left),
				"bbox_miny": float(src.bounds.bottom),
				"bbox_maxx": float(src.bounds.right),
				"bbox_maxy": float(src.bounds.top),
				"z_min": z_min,
				"z_max": z_max,
				"z_mid": float((z_min + z_max) * 0.5),
			},
			"tiles": tiles,
		}


@app.get("/api/projects/{project_id}/tif-tile-points")
def get_project_tif_tile_points(
	project_id: int,
	row_start: int = Query(ge=0),
	row_end: int = Query(ge=1),
	col_start: int = Query(ge=0),
	col_end: int = Query(ge=1),
	stride: int = Query(default=1, ge=1, le=32),
	db: Session = Depends(get_db),
) -> dict[str, object]:
	"""Return points/vertices for one precomputed tile window."""
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	tif_path = (BASE_DIR / project.tif_path).resolve()
	if not tif_path.exists():
		raise HTTPException(status_code=404, detail="TIF file not found")

	with rasterio.open(tif_path) as src:
		if row_start >= row_end or col_start >= col_end:
			raise HTTPException(status_code=400, detail="Invalid tile window")
		if row_end > src.height or col_end > src.width:
			raise HTTPException(status_code=400, detail="Tile window out of raster bounds")

		window = Window(col_start, row_start, col_end - col_start, row_end - row_start)
		band = src.read(1, masked=True, window=window)
		valid_mask = ~np.ma.getmaskarray(band)

		# Align tile sampling to a global stride phase so adjacent tiles use
		# consistent row/col lattices and can be connected across tile seams.
		first_row = row_start + ((-row_start) % stride)
		first_col = col_start + ((-col_start) % stride)
		if first_row >= row_end:
			first_row = row_start
		if first_col >= col_end:
			first_col = col_start

		sampled_rows = np.arange(first_row, row_end, stride, dtype=np.int32)
		sampled_cols = np.arange(first_col, col_end, stride, dtype=np.int32)
		if sampled_rows.size == 0 or sampled_cols.size == 0:
			return {
				"project_id": project_id,
				"point_count": 0,
				"stride": int(stride),
				"window": {
					"row_start": int(row_start),
					"row_end": int(row_end),
					"col_start": int(col_start),
					"col_end": int(col_end),
				},
				"grid": {"rows": 0, "cols": 0},
				"vertices": [],
				"points": [],
			}

		grid_rows, grid_cols = np.meshgrid(sampled_rows, sampled_cols, indexing="ij")
		rows = grid_rows.ravel()
		cols = grid_cols.ravel()

		local_rows = rows - row_start
		local_cols = cols - col_start
		valid_flat = valid_mask[local_rows, local_cols]
		sampled_band = band[local_rows, local_cols].astype(np.float64)
		z_values = np.asarray(np.ma.filled(sampled_band, np.nan), dtype=np.float64)
		x_vals, y_vals = rasterio.transform.xy(src.transform, rows, cols, offset="center")

		vertices = [
			{
				"sample_row": int(row),
				"sample_col": int(col),
				"row": int(row),
				"col": int(col),
				"x": float(x),
				"y": float(y),
				"elevation": float(z) if bool(valid) else None,
				"valid": bool(valid),
			}
			for row, col, x, y, z, valid in zip(
				rows,
				cols,
				x_vals,
				y_vals,
				z_values,
				valid_flat,
				strict=False,
			)
		]

		points = [
			[float(x), float(y), float(z)]
			for x, y, z, valid in zip(x_vals, y_vals, z_values, valid_flat, strict=False)
			if bool(valid)
		]

		return {
			"project_id": project_id,
			"point_count": len(points),
			"stride": int(stride),
			"window": {
				"row_start": int(row_start),
				"row_end": int(row_end),
				"col_start": int(col_start),
				"col_end": int(col_end),
			},
			"grid": {
				"rows": int(sampled_rows.size),
				"cols": int(sampled_cols.size),
			},
			"vertices": vertices,
			"points": points,
		}


@app.get("/api/projects/{project_id}/hdf-water-depth")
def get_project_hdf_water_depth(
	project_id: int,
	time_index: int = Query(default=-1, ge=-1),
	max_points: int = Query(default=80000, ge=1000, le=300000),
	include_dry: bool = Query(default=False),
	db: Session = Depends(get_db),
) -> dict[str, object]:
	request_start = perf_counter()
	# Receive: frontend GET /api/projects/{project_id}/hdf-water-depth with
	# time_index/max_points/include_dry query params from assets/js/three-hdf-overlay.js.
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	hdf_path = (BASE_DIR / project.hdf_path).resolve()
	if not hdf_path.exists():
		raise HTTPException(status_code=404, detail="HDF file not found")

	cell_center_ref = project.cell_center_ref or "Geometry/2D Flow Areas/Perimeter 1/Cells Center Coordinate"
	bed_elevation_ref = project.bed_elevation_ref or "Geometry/2D Flow Areas/Perimeter 1/Cells Minimum Elevation"
	water_surface_ref = project.water_surface_ref or (
		"Results/Unsteady/Output/Output Blocks/Base Output/Unsteady Time Series/"
		"2D Flow Areas/Perimeter 1/Water Surface"
	)

	static_data = _get_hdf_static_data(
		hdf_path=hdf_path,
		cell_center_ref=cell_center_ref,
		bed_elevation_ref=bed_elevation_ref,
		water_surface_ref=water_surface_ref,
	)
	t_cache_ready = perf_counter()
	coords = static_data["coords"]
	bed = static_data["bed"]
	cell_count = int(static_data["cell_count"])
	time_step_count = int(static_data["time_step_count"])

	if time_step_count == 0 or cell_count == 0:
		# Send: empty timeline frame payload to frontend when no timestep or no cell exists.
		return {
			"project_id": project_id,
			"time_index": -1,
			"time_step_count": time_step_count,
			"point_count": 0,
			"stride": 1,
			"metadata": {
				"source": str(project.hdf_path),
				"cell_center_ref": cell_center_ref,
				"bed_elevation_ref": bed_elevation_ref,
				"water_surface_ref": water_surface_ref,
			},
			"points": [],
		}

	resolved_time_index = time_step_count - 1 if time_index < 0 else time_index
	if resolved_time_index < 0 or resolved_time_index >= time_step_count:
		raise HTTPException(
			status_code=400,
			detail=f"time_index out of range: {resolved_time_index}, valid [0, {time_step_count - 1}]",
		)

	with h5py.File(hdf_path, "r") as hdf:
		if water_surface_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {water_surface_ref}")
		water_surface_ds = hdf[water_surface_ref]
		if water_surface_ds.ndim != 2 or int(water_surface_ds.shape[1]) != cell_count:
			raise HTTPException(status_code=400, detail="Inconsistent HDF dataset sizes")
		water_surface = np.asarray(water_surface_ds[resolved_time_index, :], dtype=np.float32)
	t_water_surface_read = perf_counter()

	depth = water_surface - bed

	finite_mask = (
		np.isfinite(coords[:, 0])
		& np.isfinite(coords[:, 1])
		& np.isfinite(bed)
		& np.isfinite(water_surface)
		& np.isfinite(depth)
	)
	if include_dry:
		valid_mask = finite_mask
	else:
		valid_mask = finite_mask & (depth > 0.0)

	valid_indices = np.flatnonzero(valid_mask)
	valid_count = int(valid_indices.size)
	t_valid_filter = perf_counter()

	if valid_count == 0:
		# Send: empty point list for this frame to frontend when all cells are filtered out.
		return {
			"project_id": project_id,
			"time_index": resolved_time_index,
			"time_step_count": time_step_count,
			"point_count": 0,
			"stride": 1,
			"metadata": {
				"source": str(project.hdf_path),
				"cell_center_ref": cell_center_ref,
				"bed_elevation_ref": bed_elevation_ref,
				"water_surface_ref": water_surface_ref,
			},
			"points": [],
		}

	stride = max(1, int(np.ceil(np.sqrt(valid_count / max_points))))
	sampled_indices = valid_indices[::stride]

	x_vals = coords[sampled_indices, 0]
	y_vals = coords[sampled_indices, 1]
	bed_vals = bed[sampled_indices]
	water_surface_vals = water_surface[sampled_indices]
	depth_vals = depth[sampled_indices]
	t_sampling = perf_counter()

	points = [
		[
			float(x),
			float(y),
			float(bed_z),
			float(water_z),
			float(depth_value),
		]
		for x, y, bed_z, water_z, depth_value in zip(
			x_vals,
			y_vals,
			bed_vals,
			water_surface_vals,
			depth_vals,
			strict=False,
		)
	]
	t_points_build = perf_counter()

	total_ms = (t_points_build - request_start) * 1000.0
	cache_ms = (t_cache_ready - request_start) * 1000.0
	water_read_ms = (t_water_surface_read - t_cache_ready) * 1000.0
	filter_ms = (t_valid_filter - t_water_surface_read) * 1000.0
	sampling_ms = (t_sampling - t_valid_filter) * 1000.0
	points_ms = (t_points_build - t_sampling) * 1000.0
	print(
		"[perf][hdf-water-depth] "
		f"project_id={project_id} time_index={resolved_time_index} "
		f"valid={valid_count} sampled={len(points)} stride={stride} "
		f"total_ms={total_ms:.2f} cache_ms={cache_ms:.2f} "
		f"water_read_ms={water_read_ms:.2f} filter_ms={filter_ms:.2f} "
		f"sampling_ms={sampling_ms:.2f} points_ms={points_ms:.2f}"
	)

	# Send: sampled [x, y, bed_z, water_z, depth] points and timeline metadata
	# to frontend assets/js/three-hdf-overlay.js for visualization and slider state.
	return {
		"project_id": project_id,
		"time_index": resolved_time_index,
		"time_step_count": time_step_count,
		"point_count": len(points),
		"stride": stride,
		"metadata": {
			"source": str(project.hdf_path),
			"cell_center_ref": cell_center_ref,
			"bed_elevation_ref": bed_elevation_ref,
			"water_surface_ref": water_surface_ref,
		},
		"points": points,
	}
