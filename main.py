from __future__ import annotations

from datetime import datetime, timezone
import io
from pathlib import Path
from threading import Lock
from time import perf_counter
from typing import Any
import zipfile
from xml.etree import ElementTree
from xml.sax.saxutils import escape as xml_escape

from fastapi import Depends, FastAPI, HTTPException, Query, Response as FastAPIResponse
from fastapi.responses import HTMLResponse, Response
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
from schemas import ProjectCreate, ProjectCheckRequest


BASE_DIR = Path(__file__).resolve().parent


_HDF_STATIC_CACHE_LOCK = Lock()
_HDF_STATIC_CACHE: dict[tuple[str, int, str, str, str], dict[str, Any]] = {}
_HDF_FACE_GEOMETRY_CACHE: dict[tuple[str, int, str, str], dict[str, Any]] = {}

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
XN_XLSX_PATH = BASE_DIR / "xn.xlsx"
_XN_XLSX_LOCK = Lock()
_XN_XLSX_HEADERS = [
	"timestamp_utc",
	"project_id",
	"time_index",
	"time_step_count",
	"point_count",
	"render_mode",
	"cache_mode",
	"playback_state",
	"data_gen_ms",
	"backend_transfer_ms",
	"frontend_fetch_ms",
	"frontend_parse_ms",
	"frontend_render_ms",
	"tti_ms",
	"tti_init_ms",
	"tti_project_ms",
	"tti_meta_ms",
	"tti_tiles_ms",
	"tti_rebuild_ms",
	"realtime_fps",
	"draw_calls",
	"triangles",
	"stage",
]


def _xlsx_col_name(index: int) -> str:
	letters = []
	value = index
	while value > 0:
		value, remainder = divmod(value - 1, 26)
		letters.append(chr(65 + remainder))
	return "".join(reversed(letters))


def _xlsx_is_number(value: Any) -> bool:
	if isinstance(value, bool):
		return False
	if isinstance(value, int):
		return True
	if isinstance(value, float):
		return np.isfinite(value)
	return False


def _xlsx_sheet_xml(rows: list[list[Any]]) -> str:
	row_xml_parts: list[str] = []
	for row_index, row_values in enumerate(rows, start=1):
		cell_xml_parts: list[str] = []
		for col_index, cell_value in enumerate(row_values, start=1):
			if cell_value is None:
				continue
			cell_ref = f"{_xlsx_col_name(col_index)}{row_index}"
			if _xlsx_is_number(cell_value):
				cell_xml_parts.append(f"<c r=\"{cell_ref}\"><v>{cell_value}</v></c>")
			else:
				escaped = xml_escape(str(cell_value))
				cell_xml_parts.append(f"<c r=\"{cell_ref}\" t=\"inlineStr\"><is><t>{escaped}</t></is></c>")
		row_xml_parts.append(f"<row r=\"{row_index}\">{''.join(cell_xml_parts)}</row>")
	return (
		"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
		"<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">"
		"<sheetData>"
		f"{''.join(row_xml_parts)}"
		"</sheetData>"
		"</worksheet>"
	)


def _xlsx_extract_rows(xlsx_path: Path) -> list[list[Any]]:
	if not xlsx_path.exists():
		return []
	with zipfile.ZipFile(xlsx_path, "r") as zf:
		sheet_xml = zf.read("xl/worksheets/sheet1.xml")
	root = ElementTree.fromstring(sheet_xml)
	rows: list[list[Any]] = []
	for row_el in root.findall(".//{*}sheetData/{*}row"):
		row_values: list[Any] = []
		for cell_el in row_el.findall("{*}c"):
			cell_ref = str(cell_el.get("r") or "")
			col_letters = "".join(ch for ch in cell_ref if ch.isalpha())
			col_index = 0
			for ch in col_letters:
				col_index = col_index * 26 + (ord(ch.upper()) - 64)
			if col_index <= 0:
				continue
			while len(row_values) < col_index:
				row_values.append("")
			cell_type = cell_el.get("t")
			if cell_type == "inlineStr":
				text_node = cell_el.find(".//{*}t")
				row_values[col_index - 1] = text_node.text if text_node is not None and text_node.text is not None else ""
			else:
				value_node = cell_el.find("{*}v")
				row_values[col_index - 1] = value_node.text if value_node is not None and value_node.text is not None else ""
		rows.append(row_values)
	return rows


def _xlsx_build_bytes(rows: list[list[Any]]) -> bytes:
	sheet_xml = _xlsx_sheet_xml(rows)
	workbook_xml = (
		"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
		"<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" "
		"xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
		"<sheets><sheet name=\"xn\" sheetId=\"1\" r:id=\"rId1\"/></sheets>"
		"</workbook>"
	)
	workbook_rels_xml = (
		"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
		"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
		"<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>"
		"</Relationships>"
	)
	root_rels_xml = (
		"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
		"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
		"<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>"
		"<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>"
		"<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>"
		"</Relationships>"
	)
	content_types_xml = (
		"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
		"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
		"<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
		"<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
		"<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
		"<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
		"<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>"
		"<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>"
		"</Types>"
	)
	now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
	core_xml = (
		"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
		"<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" "
		"xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
		"xmlns:dcterms=\"http://purl.org/dc/terms/\" "
		"xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" "
		"xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">"
		"<dc:creator>HECRAS-3D</dc:creator>"
		"<cp:lastModifiedBy>HECRAS-3D</cp:lastModifiedBy>"
		f"<dcterms:created xsi:type=\"dcterms:W3CDTF\">{now_iso}</dcterms:created>"
		f"<dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now_iso}</dcterms:modified>"
		"</cp:coreProperties>"
	)
	app_xml = (
		"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
		"<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" "
		"xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\">"
		"<Application>HECRAS-3D</Application>"
		"</Properties>"
	)
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
		zf.writestr("[Content_Types].xml", content_types_xml)
		zf.writestr("_rels/.rels", root_rels_xml)
		zf.writestr("xl/workbook.xml", workbook_xml)
		zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml)
		zf.writestr("xl/worksheets/sheet1.xml", sheet_xml)
		zf.writestr("docProps/core.xml", core_xml)
		zf.writestr("docProps/app.xml", app_xml)
	return buffer.getvalue()


def _append_xn_xlsx(payload: dict[str, Any]) -> int:
	with _XN_XLSX_LOCK:
		existing_rows = _xlsx_extract_rows(XN_XLSX_PATH)
		if not existing_rows:
			existing_rows = [list(_XN_XLSX_HEADERS)]
		else:
			existing_header = [str(cell) for cell in existing_rows[0]]
			if existing_header != _XN_XLSX_HEADERS:
				header_index = {name: idx for idx, name in enumerate(existing_header)}
				normalized_rows: list[list[Any]] = [list(_XN_XLSX_HEADERS)]
				for old_row in existing_rows[1:]:
					normalized_row = []
					for header_name in _XN_XLSX_HEADERS:
						cell_idx = header_index.get(header_name, -1)
						if cell_idx < 0 or cell_idx >= len(old_row):
							normalized_row.append("")
						else:
							normalized_row.append(old_row[cell_idx])
					normalized_rows.append(normalized_row)
				existing_rows = normalized_rows
		metrics = payload.get("metrics")
		metrics_map = metrics if isinstance(metrics, dict) else {}
		row = [
			datetime.now(timezone.utc).isoformat(),
			payload.get("project_id"),
			payload.get("time_index"),
			payload.get("time_step_count"),
			payload.get("point_count"),
			payload.get("render_mode"),
			payload.get("cache_mode"),
			payload.get("playback_state"),
			metrics_map.get("data_gen_ms"),
			metrics_map.get("backend_transfer_ms"),
			metrics_map.get("frontend_fetch_ms"),
			metrics_map.get("frontend_parse_ms"),
			metrics_map.get("frontend_render_ms"),
			metrics_map.get("tti_ms"),
			metrics_map.get("tti_init_ms"),
			metrics_map.get("tti_project_ms"),
			metrics_map.get("tti_meta_ms"),
			metrics_map.get("tti_tiles_ms"),
			metrics_map.get("tti_rebuild_ms"),
			metrics_map.get("realtime_fps"),
			metrics_map.get("draw_calls"),
			metrics_map.get("triangles"),
			metrics_map.get("stage"),
		]
		existing_rows.append(row)
		XN_XLSX_PATH.write_bytes(_xlsx_build_bytes(existing_rows))
		return len(existing_rows) - 1


def _compute_bbox_cover_ratio(
	*,
	outer_minx: float,
	outer_miny: float,
	outer_maxx: float,
	outer_maxy: float,
	inner_minx: float,
	inner_miny: float,
	inner_maxx: float,
	inner_maxy: float,
) -> float:
	inner_area = max(0.0, inner_maxx - inner_minx) * max(0.0, inner_maxy - inner_miny)
	if inner_area <= 0:
		return 0.0
	overlap_minx = max(outer_minx, inner_minx)
	overlap_miny = max(outer_miny, inner_miny)
	overlap_maxx = min(outer_maxx, inner_maxx)
	overlap_maxy = min(outer_maxy, inner_maxy)
	overlap_area = max(0.0, overlap_maxx - overlap_minx) * max(0.0, overlap_maxy - overlap_miny)
	return overlap_area / inner_area


def _load_hdf_cell_bbox(
	hdf_file: Path,
	cell_center_ref: str,
) -> tuple[float, float, float, float]:
	with h5py.File(hdf_file, "r") as hdf:
		if cell_center_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"HDF中缺少路径: {cell_center_ref}")
		coords = np.asarray(hdf[cell_center_ref][:], dtype=np.float64)
	if coords.ndim != 2 or coords.shape[1] < 2:
		raise HTTPException(status_code=400, detail="HDF网格中心坐标维度不正确")
	minx = float(np.nanmin(coords[:, 0]))
	miny = float(np.nanmin(coords[:, 1]))
	maxx = float(np.nanmax(coords[:, 0]))
	maxy = float(np.nanmax(coords[:, 1]))
	return minx, miny, maxx, maxy


def _validate_tif_hdf_alignment(
	*,
	tif_bounds: Any,
	hdf_bbox: tuple[float, float, float, float],
	min_cover_ratio: float = 0.95,
) -> float:
	cover_ratio = _compute_bbox_cover_ratio(
		outer_minx=float(tif_bounds.left),
		outer_miny=float(tif_bounds.bottom),
		outer_maxx=float(tif_bounds.right),
		outer_maxy=float(tif_bounds.top),
		inner_minx=hdf_bbox[0],
		inner_miny=hdf_bbox[1],
		inner_maxx=hdf_bbox[2],
		inner_maxy=hdf_bbox[3],
	)
	if cover_ratio < min_cover_ratio:
		raise HTTPException(
			status_code=400,
			detail=(
				f"TIF与HDF空间范围不匹配，HDF网格仅有{cover_ratio * 100:.2f}%落在TIF范围内；"
				f"TIF bbox=({float(tif_bounds.left):.3f}, {float(tif_bounds.bottom):.3f}, "
				f"{float(tif_bounds.right):.3f}, {float(tif_bounds.top):.3f})，"
				f"HDF bbox=({hdf_bbox[0]:.3f}, {hdf_bbox[1]:.3f}, {hdf_bbox[2]:.3f}, {hdf_bbox[3]:.3f})"
			),
		)
	return cover_ratio


def _get_hdf_static_data(
	hdf_path: Path,
	cell_center_ref: str,
	bed_elevation_ref: str,
	water_surface_ref: str,
	use_cache: bool = True,
) -> dict[str, Any]:
	cache_key = None
	if use_cache:
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
	if not use_cache:
		return static_data

	with _HDF_STATIC_CACHE_LOCK:
		cached = _HDF_STATIC_CACHE.get(cache_key)
		if cached is not None:
			return cached
		stale_keys = [key for key in _HDF_STATIC_CACHE if key[0] == str(hdf_path) and key != cache_key]
		for stale_key in stale_keys:
			_HDF_STATIC_CACHE.pop(stale_key, None)
		_HDF_STATIC_CACHE[cache_key] = static_data
	return static_data


def _get_hdf_face_geometry_data(
	hdf_path: Path,
	face_point_coordinate_ref: str,
	face_point_indexes_ref: str,
	use_cache: bool = True,
) -> dict[str, Any]:
	cache_key = None
	if use_cache:
		hdf_stat = hdf_path.stat()
		cache_key = (
			str(hdf_path),
			int(hdf_stat.st_mtime_ns),
			face_point_coordinate_ref,
			face_point_indexes_ref,
		)
		with _HDF_STATIC_CACHE_LOCK:
			cached = _HDF_FACE_GEOMETRY_CACHE.get(cache_key)
		if cached is not None:
			return cached

	with h5py.File(hdf_path, "r") as hdf:
		if face_point_coordinate_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {face_point_coordinate_ref}")
		if face_point_indexes_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {face_point_indexes_ref}")

		face_point_coords = np.asarray(hdf[face_point_coordinate_ref][:], dtype=np.float32)
		face_point_indexes = np.asarray(hdf[face_point_indexes_ref][:], dtype=np.int64)

		if face_point_coords.ndim != 2 or face_point_coords.shape[1] < 2:
			raise HTTPException(status_code=400, detail="Invalid face-point coordinates shape")
		if face_point_indexes.ndim != 2:
			raise HTTPException(status_code=400, detail="Invalid face-point index shape")

		face_point_count = int(face_point_coords.shape[0])
		face_count = int(face_point_indexes.shape[0])

		if face_count == 0:
			face_centers_xy = np.empty((0, 2), dtype=np.float32)
			face_has_valid_center = np.empty(0, dtype=bool)
		else:
			valid_vertex_mask = (face_point_indexes >= 0) & (face_point_indexes < face_point_count)
			safe_indexes = np.where(valid_vertex_mask, face_point_indexes, 0)
			vertex_count = valid_vertex_mask.sum(axis=1).astype(np.float32)
			has_valid_center = vertex_count > 0

			selected_x = face_point_coords[safe_indexes, 0]
			selected_y = face_point_coords[safe_indexes, 1]
			selected_x = np.where(valid_vertex_mask, selected_x, 0.0)
			selected_y = np.where(valid_vertex_mask, selected_y, 0.0)

			face_center_x = np.full(face_count, np.nan, dtype=np.float32)
			face_center_y = np.full(face_count, np.nan, dtype=np.float32)
			np.divide(selected_x.sum(axis=1), vertex_count, out=face_center_x, where=has_valid_center)
			np.divide(selected_y.sum(axis=1), vertex_count, out=face_center_y, where=has_valid_center)

			face_centers_xy = np.column_stack((face_center_x, face_center_y)).astype(np.float32, copy=False)
			face_has_valid_center = has_valid_center

		geometry_data = {
			"face_centers_xy": face_centers_xy,
			"face_has_valid_center": face_has_valid_center,
			"face_count": face_count,
		}

	if not use_cache:
		return geometry_data

	with _HDF_STATIC_CACHE_LOCK:
		cached = _HDF_FACE_GEOMETRY_CACHE.get(cache_key)
		if cached is not None:
			return cached
		stale_keys = [key for key in _HDF_FACE_GEOMETRY_CACHE if key[0] == str(hdf_path) and key != cache_key]
		for stale_key in stale_keys:
			_HDF_FACE_GEOMETRY_CACHE.pop(stale_key, None)
		_HDF_FACE_GEOMETRY_CACHE[cache_key] = geometry_data
	return geometry_data


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


def _sample_tif_tile_window(
	*,
	src: rasterio.io.DatasetReader,
	row_start: int,
	row_end: int,
	col_start: int,
	col_end: int,
	stride: int,
) -> dict[str, Any]:
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
			"rows": np.empty(0, dtype=np.int32),
			"cols": np.empty(0, dtype=np.int32),
			"x_vals": np.empty(0, dtype=np.float32),
			"y_vals": np.empty(0, dtype=np.float32),
			"z_vals": np.empty(0, dtype=np.float32),
			"valid_flat": np.empty(0, dtype=np.uint8),
			"grid_rows": 0,
			"grid_cols": 0,
		}

	grid_rows, grid_cols = np.meshgrid(sampled_rows, sampled_cols, indexing="ij")
	rows = np.asarray(grid_rows.ravel(), dtype=np.int32)
	cols = np.asarray(grid_cols.ravel(), dtype=np.int32)

	local_rows = rows - row_start
	local_cols = cols - col_start
	valid_flat = np.asarray(valid_mask[local_rows, local_cols], dtype=np.uint8)
	sampled_band = band[local_rows, local_cols].astype(np.float64)
	z_values = np.asarray(np.ma.filled(sampled_band, np.nan), dtype=np.float32)
	x_vals, y_vals = rasterio.transform.xy(src.transform, rows, cols, offset="center")

	return {
		"rows": rows,
		"cols": cols,
		"x_vals": np.asarray(x_vals, dtype=np.float32),
		"y_vals": np.asarray(y_vals, dtype=np.float32),
		"z_vals": z_values,
		"valid_flat": valid_flat,
		"grid_rows": int(sampled_rows.size),
		"grid_cols": int(sampled_cols.size),
	}


def _apply_include_invalid_vertices(sample: dict[str, Any], include_invalid_vertices: bool) -> dict[str, Any]:
	if include_invalid_vertices:
		return sample
	valid_flat = np.asarray(sample["valid_flat"], dtype=np.uint8)
	if valid_flat.size == 0:
		return sample
	keep_mask = valid_flat.astype(bool)
	return {
		"rows": np.asarray(sample["rows"], dtype=np.int32)[keep_mask],
		"cols": np.asarray(sample["cols"], dtype=np.int32)[keep_mask],
		"x_vals": np.asarray(sample["x_vals"], dtype=np.float32)[keep_mask],
		"y_vals": np.asarray(sample["y_vals"], dtype=np.float32)[keep_mask],
		"z_vals": np.asarray(sample["z_vals"], dtype=np.float32)[keep_mask],
		"valid_flat": np.ones(int(np.count_nonzero(keep_mask)), dtype=np.uint8),
		"grid_rows": int(sample.get("grid_rows", 0)),
		"grid_cols": int(sample.get("grid_cols", 0)),
	}


def _build_tif_tile_points_json(
	*,
	project_id: int,
	row_start: int,
	row_end: int,
	col_start: int,
	col_end: int,
	stride: int,
	sample: dict[str, Any],
) -> dict[str, object]:
	rows = sample["rows"]
	cols = sample["cols"]
	x_vals = sample["x_vals"]
	y_vals = sample["y_vals"]
	z_values = sample["z_vals"]
	valid_flat = sample["valid_flat"]
	grid_rows = int(sample["grid_rows"])
	grid_cols = int(sample["grid_cols"])

	if rows.size == 0 or cols.size == 0:
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
			"rows": int(grid_rows),
			"cols": int(grid_cols),
		},
		"vertices": vertices,
		"points": points,
	}


def _encode_tif_tile_points_binary(
	*,
	project_id: int,
	row_start: int,
	row_end: int,
	col_start: int,
	col_end: int,
	stride: int,
	sample: dict[str, Any],
) -> bytes:
	"""Pack tile samples to a compact little-endian binary payload.

	Header layout (int32 x 11):
	magic, project_id, stride, row_start, row_end, col_start, col_end,
	grid_rows, grid_cols, sample_count, point_count.
	Then arrays in order:
	rows(int32), cols(int32), x(float32), y(float32), z(float32), valid(uint8).
	"""
	rows = np.asarray(sample["rows"], dtype=np.int32)
	cols = np.asarray(sample["cols"], dtype=np.int32)
	x_vals = np.asarray(sample["x_vals"], dtype=np.float32)
	y_vals = np.asarray(sample["y_vals"], dtype=np.float32)
	z_vals = np.asarray(sample["z_vals"], dtype=np.float32)
	valid = np.asarray(sample["valid_flat"], dtype=np.uint8)
	grid_rows = int(sample["grid_rows"])
	grid_cols = int(sample["grid_cols"])
	sample_count = int(rows.size)
	point_count = int(valid.sum()) if sample_count else 0

	header = np.asarray(
		[
			0x54494631,  # "TIF1"
			int(project_id),
			int(stride),
			int(row_start),
			int(row_end),
			int(col_start),
			int(col_end),
			grid_rows,
			grid_cols,
			sample_count,
			point_count,
		],
		dtype=np.int32,
	)

	chunks = [
		header.tobytes(order="C"),
		rows.tobytes(order="C"),
		cols.tobytes(order="C"),
		x_vals.tobytes(order="C"),
		y_vals.tobytes(order="C"),
		z_vals.tobytes(order="C"),
		valid.tobytes(order="C"),
	]
	return b"".join(chunks)

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


@app.get("/stress-test", response_class=HTMLResponse)
def stress_test_page() -> HTMLResponse:
	html_path = BASE_DIR / "templates" / "stress-test.html"
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

@app.post("/api/projects/check")
def check_project_files(request: ProjectCheckRequest) -> dict[str, Any]:
	tif_file = Path(request.tif_path)
	hdf_file = Path(request.hdf_path)

	if not tif_file.exists():
		return {"ok": False, "error": f"TIF文件不存在: {request.tif_path}"}
	if not hdf_file.exists():
		return {"ok": False, "error": f"HDF文件不存在: {request.hdf_path}"}

	try:
		with rasterio.open(tif_file) as src:
			bounds = src.bounds
	except Exception as e:
		return {"ok": False, "error": f"TIF文件读取失败: {e}"}

	try:
		hdf_bbox = _load_hdf_cell_bbox(hdf_file, CELL_CENTER_REF)
		cover_ratio = _validate_tif_hdf_alignment(tif_bounds=bounds, hdf_bbox=hdf_bbox)
	except HTTPException as e:
		return {"ok": False, "error": str(e.detail)}
	except Exception as e:
		return {"ok": False, "error": f"HDF文件读取失败: {e}"}

	return {"ok": True, "cover_ratio": cover_ratio}

@app.post("/api/projects")
def create_project(
	request: ProjectCreate,
	db: Session = Depends(get_db),
) -> dict[str, Any]:
	tif_file = Path(request.tif_path)
	hdf_file = Path(request.hdf_path)

	if not tif_file.exists():
		raise HTTPException(status_code=400, detail=f"TIF文件不存在: {tif_file}")
	if not hdf_file.exists():
		raise HTTPException(status_code=400, detail=f"HDF文件不存在: {hdf_file}")

	try:
		with rasterio.open(tif_file) as src:
			bounds = src.bounds
			epsg = src.crs.to_epsg() if src.crs else None
			crs = f"EPSG:{epsg}" if epsg is not None else "UNKNOWN"
			terrain_nodata = src.nodata
	except Exception as e:
		raise HTTPException(status_code=400, detail=f"TIF文件读取失败: {e}")
	hdf_bbox = _load_hdf_cell_bbox(hdf_file, CELL_CENTER_REF)
	_ = _validate_tif_hdf_alignment(tif_bounds=bounds, hdf_bbox=hdf_bbox)

	try:
		with h5py.File(hdf_file, "r") as hdf:
			if CELL_CENTER_REF not in hdf:
				raise HTTPException(status_code=400, detail=f"HDF中缺少路径: {CELL_CENTER_REF}")
			if WATER_SURFACE_REF not in hdf:
				raise HTTPException(status_code=400, detail=f"HDF中缺少路径: {WATER_SURFACE_REF}")
			if FACE_VELOCITY_REF not in hdf:
				raise HTTPException(status_code=400, detail=f"HDF中缺少路径: {FACE_VELOCITY_REF}")

			cell_count = int(hdf[CELL_CENTER_REF].shape[0])
			face_count = int(hdf[FACE_VELOCITY_REF].shape[1])
			time_step_count = int(hdf[WATER_SURFACE_REF].shape[0])
	except HTTPException:
		raise
	except Exception as e:
		raise HTTPException(status_code=400, detail=f"HDF文件读取错误: {e}")

	now = datetime.now(timezone.utc)
	hdf_mtime = datetime.fromtimestamp(hdf_file.stat().st_mtime, timezone.utc)
	tif_mtime = datetime.fromtimestamp(tif_file.stat().st_mtime, timezone.utc)

	project = Project(
		name=request.name,
		crs=crs,
		tif_path=request.tif_path,
		hdf_path=request.hdf_path,
		summary=request.summary,
		cell_center_ref=CELL_CENTER_REF,
		bed_elevation_ref=BED_ELEVATION_REF,
		water_surface_ref=WATER_SURFACE_REF,
		face_point_coordinate_ref=FACE_POINT_COORDINATE_REF,
		face_point_indexes_ref=FACE_POINT_INDEXES_REF,
		face_velocity_ref=FACE_VELOCITY_REF,
		time_axis_ref=TIME_AXIS_REF,
		time_label_ref=TIME_LABEL_REF,
		bbox_minx=bounds.left,
		bbox_miny=bounds.bottom,
		bbox_maxx=bounds.right,
		bbox_maxy=bounds.top,
		terrain_nodata=terrain_nodata,
		cell_count=cell_count,
		face_count=face_count,
		time_step_count=time_step_count,
		file_mtime_hdf=hdf_mtime,
		file_mtime_tif=tif_mtime,
		indexed_at=now,
	)
	db.add(project)
	try:
		db.commit()
		db.refresh(project)
	except Exception as e:
		db.rollback()
		raise HTTPException(status_code=400, detail=f"数据库错误: {e}")

	return {"ok": True, "project_id": project.id}


@app.get("/api/projects/{project_id}/tif-points")
def get_project_tif_points(
	project_id: int,
	max_points: int = Query(default=100000, ge=1000, le=300000),
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


@app.get("/api/projects/{project_id}/tif-stress-json")
def get_project_tif_stress_json(
	project_id: int,
	target_points: int = Query(default=200000, ge=10000, le=10000000),
	include_invalid_vertices: bool = Query(default=True),
	db: Session = Depends(get_db),
) -> dict[str, object]:
	"""Return a single large JSON payload for front-end stress tests.

	This endpoint is intended for testing the old pipeline:
	backend loads tif -> sends one big json -> frontend parses and renders
	color-band surface + grid polylines in one shot.
	"""
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
			return {
				"project_id": project_id,
				"target_points": int(target_points),
				"point_count": 0,
				"sample_count": 0,
				"stride": 1,
				"grid": {
					"rows": 0,
					"cols": 0,
					"sample_stride": 1,
				},
				"metadata": {
					"source": str(project.tif_path),
					"crs": src.crs.to_string() if src.crs else "UNKNOWN",
					"width": int(src.width),
					"height": int(src.height),
					"nodata": src.nodata,
					"valid_point_count": 0,
				},
				"vertices": [],
				"points": [],
			}

		stride = max(1, int(np.ceil(np.sqrt(valid_count / max(target_points, 1)))))
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

		if include_invalid_vertices:
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
		else:
			vertices = [
				{
					"sample_row": int(sample_row),
					"sample_col": int(sample_col),
					"row": int(row),
					"col": int(col),
					"x": float(x),
					"y": float(y),
					"elevation": float(z),
					"valid": True,
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
				if bool(valid)
			]

		points = [
			[float(x), float(y), float(z)]
			for x, y, z, valid in zip(x_vals, y_vals, z_values, valid_flat, strict=False)
			if bool(valid)
		]

		return {
			"project_id": project_id,
			"target_points": int(target_points),
			"point_count": len(points),
			"sample_count": int(rows.size),
			"stride": int(stride),
			"grid": {
				"rows": int(sampled_rows.size),
				"cols": int(sampled_cols.size),
				"sample_stride": 1,
			},
			"metadata": {
				"source": str(project.tif_path),
				"crs": src.crs.to_string() if src.crs else "UNKNOWN",
				"width": int(src.width),
				"height": int(src.height),
				"nodata": src.nodata,
				"valid_point_count": valid_count,
			},
			"vertices": vertices,
			"points": points,
		}


@app.get("/api/stress/synthetic-grid-json")
def get_synthetic_grid_stress_json(
	target_points: int = Query(default=200000, ge=10000, le=10000000),
	include_invalid_vertices: bool = Query(default=True),
) -> dict[str, object]:
	"""Generate synthetic terrain-like JSON payload for browser stress tests.

	Used to benchmark one-shot JSON transport/parse/render without TIF IO.
	"""
	target = int(target_points)
	grid_cols = max(1, int(np.ceil(np.sqrt(target))))
	grid_rows = max(1, int(np.ceil(target / grid_cols)))
	sample_count = int(grid_rows * grid_cols)

	indices = np.arange(sample_count, dtype=np.int64)
	rows = (indices // grid_cols).astype(np.int32)
	cols = (indices % grid_cols).astype(np.int32)

	x_vals = cols.astype(np.float64)
	y_vals = rows.astype(np.float64)
	z_vals = (
		8.0 * np.sin(x_vals * 0.015)
		+ 6.0 * np.cos(y_vals * 0.013)
		+ 0.002 * x_vals
		+ 0.0015 * y_vals
	).astype(np.float64)

	valid_flat = np.ones(sample_count, dtype=np.uint8)
	if sample_count > target:
		valid_flat[target:] = 0

	if include_invalid_vertices:
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
				z_vals,
				valid_flat,
				strict=False,
			)
		]
	else:
		vertices = [
			{
				"sample_row": int(row),
				"sample_col": int(col),
				"row": int(row),
				"col": int(col),
				"x": float(x),
				"y": float(y),
				"elevation": float(z),
				"valid": True,
			}
			for row, col, x, y, z, valid in zip(
				rows,
				cols,
				x_vals,
				y_vals,
				z_vals,
				valid_flat,
				strict=False,
			)
			if bool(valid)
		]

	points = [
		[float(x), float(y), float(z)]
		for x, y, z, valid in zip(x_vals, y_vals, z_vals, valid_flat, strict=False)
		if bool(valid)
	]

	return {
		"project_id": None,
		"target_points": target,
		"point_count": len(points),
		"sample_count": sample_count,
		"stride": 1,
		"grid": {
			"rows": int(grid_rows),
			"cols": int(grid_cols),
			"sample_stride": 1,
		},
		"metadata": {
			"source": "synthetic-grid",
			"crs": "LOCAL_SYNTHETIC",
			"width": int(grid_cols),
			"height": int(grid_rows),
			"nodata": None,
			"valid_point_count": target,
		},
		"vertices": vertices,
		"points": points,
	}


@app.get("/api/projects/{project_id}/tif-tiles")
def get_project_tif_tiles(
	project_id: int,
	target_points_per_tile: int = Query(default=25000, ge=10000, le=99999),
	response: FastAPIResponse = None,
	db: Session = Depends(get_db),
) -> dict[str, object]:
	"""Return uniformly split square tile metadata and tile centers for lazy loading."""
	request_start = perf_counter()
	t_read_done = request_start
	t_mask_done = request_start
	t_stats_done = request_start
	t_integral_done = request_start
	t_build_done = request_start

	def _set_timing_header(final_mark: float) -> None:
		total_ms = (final_mark - request_start) * 1000.0
		read_ms = max(0.0, (t_read_done - request_start) * 1000.0)
		mask_ms = max(0.0, (t_mask_done - t_read_done) * 1000.0)
		stats_ms = max(0.0, (t_stats_done - t_mask_done) * 1000.0)
		integral_ms = max(0.0, (t_integral_done - t_stats_done) * 1000.0)
		build_ms = max(0.0, (t_build_done - t_integral_done) * 1000.0)
		gen_ms = max(0.0, (t_build_done - request_start) * 1000.0)
		if response is not None:
			response.headers["Server-Timing"] = (
				f"total;dur={total_ms:.2f},gen;dur={gen_ms:.2f},"
				f"read;dur={read_ms:.2f},mask;dur={mask_ms:.2f},"
				f"stats;dur={stats_ms:.2f},integral;dur={integral_ms:.2f},build;dur={build_ms:.2f}"
			)

	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	tif_path = (BASE_DIR / project.tif_path).resolve()
	if not tif_path.exists():
		raise HTTPException(status_code=404, detail="TIF file not found")

	with rasterio.open(tif_path) as src:
		band = src.read(1, masked=True)
		t_read_done = perf_counter()
		valid_mask = ~np.ma.getmaskarray(band)
		valid_count = int(valid_mask.sum())
		t_mask_done = perf_counter()
		z_values = np.asarray(np.ma.filled(band.astype(np.float64), np.nan), dtype=np.float64)
		z_min = float(np.nanmin(z_values)) if np.isfinite(np.nanmin(z_values)) else 0.0
		z_max = float(np.nanmax(z_values)) if np.isfinite(np.nanmax(z_values)) else 0.0
		t_stats_done = perf_counter()

		if valid_count == 0:
			result = {
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
			t_integral_done = t_stats_done
			t_build_done = perf_counter()
			_set_timing_header(perf_counter())
			return result

		tile_axis_count, tile_bounds = _build_square_tile_bounds(
			width=int(src.width),
			height=int(src.height),
			valid_count=valid_count,
			target_points_per_tile=int(target_points_per_tile),
		)

		integral = np.cumsum(np.cumsum(valid_mask.astype(np.int32), axis=0), axis=1)
		t_integral_done = perf_counter()

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

		result = {
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
		t_build_done = perf_counter()
		_set_timing_header(perf_counter())
		return result


@app.get("/api/projects/{project_id}/tif-tile-points")
def get_project_tif_tile_points(
	project_id: int,
	row_start: int = Query(ge=0),
	row_end: int = Query(ge=1),
	col_start: int = Query(ge=0),
	col_end: int = Query(ge=1),
	stride: int = Query(default=1, ge=1, le=32),
	include_invalid_vertices: bool = Query(default=True),
	response: FastAPIResponse = None,
	db: Session = Depends(get_db),
) -> dict[str, object]:
	"""Return points/vertices for one precomputed tile window."""
	request_start = perf_counter()
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	tif_path = (BASE_DIR / project.tif_path).resolve()
	if not tif_path.exists():
		raise HTTPException(status_code=404, detail="TIF file not found")

	with rasterio.open(tif_path) as src:
		sample = _sample_tif_tile_window(
			src=src,
			row_start=row_start,
			row_end=row_end,
			col_start=col_start,
			col_end=col_end,
			stride=stride,
		)
		sample = _apply_include_invalid_vertices(sample, include_invalid_vertices)

		result = _build_tif_tile_points_json(
			project_id=project_id,
			row_start=row_start,
			row_end=row_end,
			col_start=col_start,
			col_end=col_end,
			stride=stride,
			sample=sample,
		)
		total_ms = (perf_counter() - request_start) * 1000.0
		if response is not None:
			response.headers["Server-Timing"] = f"total;dur={total_ms:.2f},gen;dur={total_ms:.2f}"
		return result


@app.get("/api/projects/{project_id}/tif-tile-points-binary")
def get_project_tif_tile_points_binary(
	project_id: int,
	row_start: int = Query(ge=0),
	row_end: int = Query(ge=1),
	col_start: int = Query(ge=0),
	col_end: int = Query(ge=1),
	stride: int = Query(default=1, ge=1, le=32),
	include_invalid_vertices: bool = Query(default=True),
	db: Session = Depends(get_db),
) -> Response:
	"""Return compact binary tile samples for faster transfer and decode."""
	request_start = perf_counter()
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	tif_path = (BASE_DIR / project.tif_path).resolve()
	if not tif_path.exists():
		raise HTTPException(status_code=404, detail="TIF file not found")

	with rasterio.open(tif_path) as src:
		sample = _sample_tif_tile_window(
			src=src,
			row_start=row_start,
			row_end=row_end,
			col_start=col_start,
			col_end=col_end,
			stride=stride,
		)
		sample = _apply_include_invalid_vertices(sample, include_invalid_vertices)
	t_sample_ready = perf_counter()

	payload = _encode_tif_tile_points_binary(
		project_id=project_id,
		row_start=row_start,
		row_end=row_end,
		col_start=col_start,
		col_end=col_end,
		stride=stride,
		sample=sample,
	)
	t_payload_ready = perf_counter()
	gen_ms = (t_payload_ready - request_start) * 1000.0
	total_ms = gen_ms
	sample_ms = (t_sample_ready - request_start) * 1000.0
	encode_ms = (t_payload_ready - t_sample_ready) * 1000.0
	return Response(
		content=payload,
		media_type="application/octet-stream",
		headers={
			"Server-Timing": f"total;dur={total_ms:.2f},gen;dur={gen_ms:.2f},sample;dur={sample_ms:.2f},encode;dur={encode_ms:.2f}",
		},
	)


@app.get("/api/projects/{project_id}/hdf-water-depth")
def get_project_hdf_water_depth(
	project_id: int,
	time_index: int = Query(default=0, ge=-1),
	max_points: int = Query(default=80000, ge=1000, le=300000),
	include_dry: bool = Query(default=False),
	min_depth: float = Query(default=0.05, ge=0.0, le=1000.0),
	use_cache: bool = Query(default=True),
	response: FastAPIResponse = None,
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
	face_point_coordinate_ref = project.face_point_coordinate_ref or FACE_POINT_COORDINATE_REF
	face_point_indexes_ref = project.face_point_indexes_ref or FACE_POINT_INDEXES_REF
	face_velocity_ref = project.face_velocity_ref or FACE_VELOCITY_REF

	static_data = _get_hdf_static_data(
		hdf_path=hdf_path,
		cell_center_ref=cell_center_ref,
		bed_elevation_ref=bed_elevation_ref,
		water_surface_ref=water_surface_ref,
		use_cache=use_cache,
	)
	face_geometry_data = _get_hdf_face_geometry_data(
		hdf_path=hdf_path,
		face_point_coordinate_ref=face_point_coordinate_ref,
		face_point_indexes_ref=face_point_indexes_ref,
		use_cache=use_cache,
	)
	t_cache_ready = perf_counter()
	coords = static_data["coords"]
	bed = static_data["bed"]
	cell_count = int(static_data["cell_count"])
	time_step_count = int(static_data["time_step_count"])
	face_centers_xy = face_geometry_data["face_centers_xy"]
	face_has_valid_center = face_geometry_data["face_has_valid_center"]
	face_count = int(face_geometry_data["face_count"])

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
				"face_point_coordinate_ref": face_point_coordinate_ref,
				"face_point_indexes_ref": face_point_indexes_ref,
				"face_velocity_ref": face_velocity_ref,
			},
			"velocity_face_count": 0,
			"velocity_faces": [],
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
		if face_velocity_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {face_velocity_ref}")
		water_surface_ds = hdf[water_surface_ref]
		face_velocity_ds = hdf[face_velocity_ref]
		if water_surface_ds.ndim != 2 or int(water_surface_ds.shape[1]) != cell_count:
			raise HTTPException(status_code=400, detail="Inconsistent HDF dataset sizes")
		if face_velocity_ds.ndim != 2:
			raise HTTPException(status_code=400, detail="Invalid face velocity shape")
		if int(face_velocity_ds.shape[1]) != face_count:
			raise HTTPException(status_code=400, detail="Inconsistent face velocity dataset sizes")
		if resolved_time_index < 0 or resolved_time_index >= int(face_velocity_ds.shape[0]):
			raise HTTPException(
				status_code=400,
				detail=(
					f"face velocity time_index out of range: {resolved_time_index}, "
					f"valid [0, {int(face_velocity_ds.shape[0]) - 1}]"
				),
			)
		water_surface = np.asarray(water_surface_ds[resolved_time_index, :], dtype=np.float32)
		t_water_surface_read = perf_counter()
		face_velocity = np.asarray(face_velocity_ds[resolved_time_index, :], dtype=np.float32)
	t_face_velocity_read = perf_counter()

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
		valid_mask = finite_mask & (depth > min_depth)

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
				"face_point_coordinate_ref": face_point_coordinate_ref,
				"face_point_indexes_ref": face_point_indexes_ref,
				"face_velocity_ref": face_velocity_ref,
				"include_dry": include_dry,
				"min_depth": float(min_depth),
			},
			"velocity_face_count": 0,
			"velocity_faces": [],
			"points": [],
		}

	# Keep full HDF scatter points; caller confirmed count is within acceptable range.
	stride = 1
	sampled_indices = valid_indices

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

	velocity_valid_mask = (
		face_has_valid_center
		& np.isfinite(face_centers_xy[:, 0])
		& np.isfinite(face_centers_xy[:, 1])
		& np.isfinite(face_velocity)
	)
	velocity_indices = np.flatnonzero(velocity_valid_mask)
	velocity_faces = [
		[
			float(face_centers_xy[idx, 0]),
			float(face_centers_xy[idx, 1]),
			float(face_velocity[idx]),
		]
		for idx in velocity_indices
	]
	t_velocity_faces_build = perf_counter()

	total_ms = (t_velocity_faces_build - request_start) * 1000.0
	cache_ms = (t_cache_ready - request_start) * 1000.0
	water_read_ms = (t_water_surface_read - t_cache_ready) * 1000.0
	velocity_read_ms = (t_face_velocity_read - t_water_surface_read) * 1000.0
	filter_ms = (t_valid_filter - t_face_velocity_read) * 1000.0
	sampling_ms = (t_sampling - t_valid_filter) * 1000.0
	points_ms = (t_points_build - t_sampling) * 1000.0
	velocity_faces_ms = (t_velocity_faces_build - t_points_build) * 1000.0
	print(
		"[perf][hdf-water-depth] "
		f"project_id={project_id} time_index={resolved_time_index} "
		f"use_cache={int(use_cache)} "
		f"valid={valid_count} sampled={len(points)} velocity_faces={len(velocity_faces)} stride={stride} "
		f"total_ms={total_ms:.2f} cache_ms={cache_ms:.2f} "
		f"water_read_ms={water_read_ms:.2f} velocity_read_ms={velocity_read_ms:.2f} "
		f"filter_ms={filter_ms:.2f} sampling_ms={sampling_ms:.2f} "
		f"points_ms={points_ms:.2f} velocity_faces_ms={velocity_faces_ms:.2f}"
	)

	# Send: sampled [x, y, bed_z, water_z, depth] points and face-centered
	# [x, y, velocity] arrays to frontend assets/js/three-hdf-overlay.js.
	result = {
		"project_id": project_id,
		"time_index": resolved_time_index,
		"time_step_count": time_step_count,
		"point_count": len(points),
		"velocity_face_count": len(velocity_faces),
		"stride": stride,
		"metadata": {
			"source": str(project.hdf_path),
			"cell_center_ref": cell_center_ref,
			"bed_elevation_ref": bed_elevation_ref,
			"water_surface_ref": water_surface_ref,
			"face_point_coordinate_ref": face_point_coordinate_ref,
			"face_point_indexes_ref": face_point_indexes_ref,
			"face_velocity_ref": face_velocity_ref,
			"include_dry": include_dry,
			"min_depth": float(min_depth),
		},
		"timings": {
			"total_ms": float(total_ms),
			"cache_ms": float(cache_ms),
			"water_read_ms": float(water_read_ms),
			"velocity_read_ms": float(velocity_read_ms),
			"filter_ms": float(filter_ms),
			"sampling_ms": float(sampling_ms),
			"points_ms": float(points_ms),
			"velocity_faces_ms": float(velocity_faces_ms),
		},
		"velocity_faces": velocity_faces,
		"points": points,
	}
	if response is not None:
		response.headers["Server-Timing"] = (
			f"total;dur={total_ms:.2f},gen;dur={total_ms:.2f},cache;dur={cache_ms:.2f},"
			f"water;dur={water_read_ms:.2f},velocity;dur={velocity_read_ms:.2f},"
			f"filter;dur={filter_ms:.2f},sampling;dur={sampling_ms:.2f},"
			f"points;dur={points_ms:.2f},velocity_faces;dur={velocity_faces_ms:.2f}"
		)
	return result


@app.post("/api/hdf/write-xn-xlsx")
def write_hdf_snapshot_to_xn_xlsx(payload: dict[str, Any]) -> dict[str, object]:
	row_count = _append_xn_xlsx(payload)
	return {
		"ok": True,
		"path": str(XN_XLSX_PATH.name),
		"rows": row_count,
	}
