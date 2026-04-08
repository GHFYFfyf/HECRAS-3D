from __future__ import annotations

from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
from threading import Lock
from time import perf_counter
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest
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
from rasterio.crs import CRS
from rasterio.warp import transform as rio_transform
from rasterio.windows import Window
from sqlalchemy import select
from sqlalchemy.orm import Session

from database import Base, engine, get_db
from models import Project
from schemas import ProjectCreate, ProjectCheckRequest


BASE_DIR = Path(__file__).resolve().parent


_HDF_STATIC_CACHE_LOCK = Lock()
_HDF_STATIC_CACHE: dict[tuple[str, int, str, str, str, str], dict[str, Any]] = {}
_HDF_FACE_GEOMETRY_CACHE: dict[tuple[str, int, str, str], dict[str, Any]] = {}

CELL_CENTER_REF = "Geometry/2D Flow Areas/Perimeter 1/Cells Center Coordinate"
BED_ELEVATION_REF = "Geometry/2D Flow Areas/Perimeter 1/Cells Minimum Elevation"
WATER_SURFACE_REF = (
	"Results/Unsteady/Output/Output Blocks/Base Output/Unsteady Time Series/"
	"2D Flow Areas/Perimeter 1/Water Surface"
)
CELL_SURFACE_AREA_REF = "Geometry/2D Flow Areas/Perimeter 1/Cells Surface Area"
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
FLOW_HYDROGRAPH_PREFIX = "Event Conditions/Unsteady/Boundary Conditions/Flow Hydrographs/"
FLOW_HDF_SUFFIX_PRIORITY = (
	".u01.hdf",
	".g01.hdf",
	".hdf",
	".p01.hdf",
)
HYDRO_LABEL_VOCAB = ("退水", "涨水", "泄洪", "干枯", "稳态")
HYDRO_LABEL_SYNONYMS = {
	"平稳": "稳态",
	"稳定": "稳态",
	"稳": "稳态",
	"枯水": "干枯",
	"上涨": "涨水",
	"下泄": "泄洪",
}
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
	cell_surface_area_ref: str | None = None,
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
			cell_surface_area_ref or "",
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
		cell_surface_area = None
		if cell_surface_area_ref and cell_surface_area_ref in hdf:
			cell_surface_area_raw = np.asarray(hdf[cell_surface_area_ref][:], dtype=np.float32)
			if cell_surface_area_raw.ndim == 1 and int(cell_surface_area_raw.shape[0]) == int(coords.shape[0]):
				cell_surface_area = cell_surface_area_raw

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
			"cell_surface_area": cell_surface_area,
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


def _ensure_projects_table_columns() -> None:
	required_columns = {
		"flow_hdf_path": "TEXT",
		"flow_hydrograph_ref": "TEXT",
		"flow_time_ref": "TEXT",
		"hydro_label": "TEXT",
		"hydro_label_confidence": "REAL",
		"hydro_label_updated_at": "TEXT",
	}
	with engine.begin() as connection:
		rows = connection.exec_driver_sql("PRAGMA table_info(projects)").fetchall()
		existing_columns = {str(row[1]) for row in rows}
		for column_name, column_type in required_columns.items():
			if column_name in existing_columns:
				continue
			connection.exec_driver_sql(f"ALTER TABLE projects ADD COLUMN {column_name} {column_type}")


def _prune_projects_table_columns() -> None:
	deprecated_columns = {"hydro_label_reason"}
	with engine.begin() as connection:
		rows = connection.exec_driver_sql("PRAGMA table_info(projects)").fetchall()
		existing_columns = {str(row[1]) for row in rows}
		for column_name in deprecated_columns:
			if column_name not in existing_columns:
				continue
			try:
				connection.exec_driver_sql(f"ALTER TABLE projects DROP COLUMN {column_name}")
			except Exception:
				# Keep compatibility with SQLite versions that do not support DROP COLUMN.
				continue


def _split_hdf_base_name(file_name: str) -> str:
	lower_name = file_name.lower()
	for suffix in FLOW_HDF_SUFFIX_PRIORITY:
		if lower_name.endswith(suffix):
			return file_name[: len(file_name) - len(suffix)]
	return Path(file_name).stem


def _candidate_flow_hdf_paths(project_hdf_path: Path) -> list[Path]:
	project_hdf_path = project_hdf_path.resolve()
	base_name = _split_hdf_base_name(project_hdf_path.name)
	candidates: list[Path] = []
	for suffix in FLOW_HDF_SUFFIX_PRIORITY:
		candidate = (project_hdf_path.parent / f"{base_name}{suffix}").resolve()
		if not candidate.exists() or candidate in candidates:
			continue
		candidates.append(candidate)
	if project_hdf_path.exists() and project_hdf_path not in candidates:
		candidates.append(project_hdf_path)
	return candidates


def _discover_flow_hydrograph_ref(hdf_path: Path) -> tuple[str | None, str | None]:
	flow_refs: list[str] = []
	with h5py.File(hdf_path, "r") as hdf:
		def _visitor(name: str, obj: Any) -> None:
			if not isinstance(obj, h5py.Dataset):
				return
			if not name.startswith(FLOW_HYDROGRAPH_PREFIX):
				return
			if obj.ndim < 1 or int(obj.shape[0]) <= 0:
				return
			flow_refs.append(name)

		hdf.visititems(_visitor)
		if not flow_refs:
			return None, None

		flow_refs.sort()
		preferred_ref = next(
			(ref for ref in flow_refs if "bcline: st" in ref.lower()),
			flow_refs[0],
		)
		time_ref = TIME_AXIS_REF if TIME_AXIS_REF in hdf else None
		return preferred_ref, time_ref


def _resolve_project_flow_source(project_hdf_path: Path) -> tuple[Path | None, str | None, str | None]:
	for candidate_path in _candidate_flow_hdf_paths(project_hdf_path):
		try:
			flow_ref, time_ref = _discover_flow_hydrograph_ref(candidate_path)
		except Exception:
			continue
		if flow_ref:
			return candidate_path, flow_ref, time_ref
	return None, None, None


def _normalize_time_axis_to_hours(raw_time_values: np.ndarray) -> np.ndarray:
	if raw_time_values.size == 0:
		return raw_time_values
	relative = raw_time_values - float(raw_time_values[0])
	if relative.size <= 1:
		return np.zeros_like(relative, dtype=np.float64)
	diffs = np.diff(relative)
	valid_diffs = diffs[np.isfinite(diffs) & (diffs > 0)]
	if valid_diffs.size == 0:
		return np.arange(relative.size, dtype=np.float64)
	median_step = float(np.median(valid_diffs))
	if median_step < 0.2:
		scale_to_hour = 24.0
	elif median_step > 1200.0:
		scale_to_hour = 1.0 / 3600.0
	elif median_step > 5.0:
		scale_to_hour = 1.0 / 60.0
	else:
		scale_to_hour = 1.0
	return relative * scale_to_hour


def _extract_flow_hydrograph_series(
	*,
	hdf_path: Path,
	flow_hydrograph_ref: str,
	flow_time_ref: str | None,
) -> dict[str, Any]:
	with h5py.File(hdf_path, "r") as hdf:
		if flow_hydrograph_ref not in hdf:
			raise HTTPException(status_code=400, detail=f"Missing HDF path: {flow_hydrograph_ref}")

		hydrograph_raw = np.asarray(hdf[flow_hydrograph_ref][:], dtype=np.float64)
		if hydrograph_raw.ndim == 1:
			time_values = np.arange(hydrograph_raw.shape[0], dtype=np.float64)
			flow_values = hydrograph_raw
		elif hydrograph_raw.ndim >= 2:
			flattened = hydrograph_raw.reshape(hydrograph_raw.shape[0], -1)
			if flattened.shape[1] >= 2:
				time_values = flattened[:, 0]
				flow_values = flattened[:, 1]
			else:
				time_values = np.arange(flattened.shape[0], dtype=np.float64)
				flow_values = flattened[:, 0]
		else:
			raise HTTPException(status_code=400, detail="Invalid flow hydrograph shape")

		if flow_time_ref and flow_time_ref in hdf:
			time_ds = np.asarray(hdf[flow_time_ref][:], dtype=np.float64)
			if time_ds.ndim == 1 and time_ds.shape[0] == flow_values.shape[0]:
				time_values = time_ds

	finite_mask = np.isfinite(time_values) & np.isfinite(flow_values)
	time_values = time_values[finite_mask]
	flow_values = flow_values[finite_mask]
	if flow_values.size == 0:
		raise HTTPException(status_code=400, detail="Flow hydrograph dataset is empty after filtering")

	time_hours = _normalize_time_axis_to_hours(time_values)
	order = np.argsort(time_hours)
	time_hours = time_hours[order]
	flow_values = flow_values[order]

	# Keep monotonic x-axis for interpolation by dropping duplicate time samples.
	rounded_hours = np.round(time_hours, decimals=9)
	_, unique_indices = np.unique(rounded_hours, return_index=True)
	time_hours = time_hours[unique_indices]
	flow_values = flow_values[unique_indices]
	if flow_values.size == 0:
		raise HTTPException(status_code=400, detail="Flow hydrograph dataset has no unique time samples")

	if time_hours.size > 1:
		max_hour = float(time_hours[-1])
		hour_grid = np.arange(0.0, np.floor(max_hour) + 1.0, 1.0, dtype=np.float64)
		if hour_grid.size == 0:
			hour_grid = np.array([0.0], dtype=np.float64)
		if float(hour_grid[-1]) < max_hour:
			hour_grid = np.append(hour_grid, np.ceil(max_hour))
		flow_hourly = np.interp(hour_grid, time_hours, flow_values)
	else:
		hour_grid = np.array([0.0], dtype=np.float64)
		flow_hourly = np.array([float(flow_values[0])], dtype=np.float64)

	peak_index = int(np.argmax(flow_hourly))
	return {
		"sample_count": int(flow_hourly.size),
		"time_unit": "hour",
		"time_interval_hour": 1,
		"peak_flow": float(flow_hourly[peak_index]),
		"peak_time": float(hour_grid[peak_index]),
		"current_flow": float(flow_hourly[-1]),
		"current_time": float(hour_grid[-1]),
		"avg_flow": float(np.mean(flow_hourly)),
		"series": [
			[float(t), float(q)]
			for t, q in zip(hour_grid, flow_hourly, strict=False)
		],
	}


def _normalize_hydro_label(label: Any) -> str:
	raw_label = str(label).strip() if label is not None else ""
	if raw_label in HYDRO_LABEL_VOCAB:
		return raw_label
	mapped = HYDRO_LABEL_SYNONYMS.get(raw_label, "")
	if mapped in HYDRO_LABEL_VOCAB:
		return mapped
	return "稳态"


def _clamp_confidence(value: Any, default: float = 0.5) -> float:
	try:
		numeric = float(value)
	except (TypeError, ValueError):
		return float(max(0.0, min(1.0, default)))
	if not np.isfinite(numeric):
		return float(max(0.0, min(1.0, default)))
	return float(max(0.0, min(1.0, numeric)))


def _resolve_hydro_model_config() -> tuple[str, str, str]:
	api_key = (os.getenv("HYDRO_LABEL_MODEL_API_KEY") or os.getenv("DEEPSEEK_API_KEY") or "").strip()
	model_name = (
		os.getenv("HYDRO_LABEL_MODEL_NAME")
		or os.getenv("DEEPSEEK_MODEL")
		or "deepseek-chat"
	).strip()
	base_url = (
		os.getenv("HYDRO_LABEL_MODEL_BASE_URL")
		or os.getenv("DEEPSEEK_BASE_URL")
		or "https://api.deepseek.com"
	).strip().rstrip("/")
	return api_key, model_name, base_url


def _default_hydro_label_mode() -> str:
	raw_mode = str(os.getenv("HYDRO_LABEL_DEFAULT_MODE") or "hybrid").strip().lower()
	if raw_mode in {"rule", "ai", "hybrid"}:
		return raw_mode
	return "hybrid"


def _resolve_hydro_summary_temperature() -> float:
	raw_value = str(os.getenv("HYDRO_SUMMARY_TEMPERATURE") or "").strip()
	if not raw_value:
		return 0.65
	try:
		temperature = float(raw_value)
	except (TypeError, ValueError):
		return 0.65
	if not np.isfinite(temperature):
		return 0.65
	return float(max(0.0, min(1.5, temperature)))


def _to_wgs84_point(x: float, y: float, source_crs_text: str | None) -> tuple[float | None, float | None]:
	if not source_crs_text:
		return None, None
	if not (np.isfinite(x) and np.isfinite(y)):
		return None, None
	try:
		source_crs = CRS.from_user_input(source_crs_text)
		if source_crs is None:
			return None, None
		lon_values, lat_values = rio_transform(source_crs, CRS.from_epsg(4326), [x], [y])
		if len(lon_values) == 0 or len(lat_values) == 0:
			return None, None
		lon = float(lon_values[0])
		lat = float(lat_values[0])
		if not (np.isfinite(lon) and np.isfinite(lat)):
			return None, None
		return lon, lat
	except Exception:
		return None, None


def _build_project_geo_context(project: Project) -> dict[str, Any]:
	minx = project.bbox_minx
	miny = project.bbox_miny
	maxx = project.bbox_maxx
	maxy = project.bbox_maxy
	has_bbox = all(v is not None for v in (minx, miny, maxx, maxy))
	center_x = ((float(minx) + float(maxx)) / 2.0) if has_bbox else None
	center_y = ((float(miny) + float(maxy)) / 2.0) if has_bbox else None
	center_lon = None
	center_lat = None
	if center_x is not None and center_y is not None:
		center_lon, center_lat = _to_wgs84_point(center_x, center_y, project.crs)
	return {
		"name": project.name,
		"crs": project.crs,
		"bbox": {
			"minx": minx,
			"miny": miny,
			"maxx": maxx,
			"maxy": maxy,
		},
		"center": {
			"x": center_x,
			"y": center_y,
		},
		"center_wgs84": {
			"lon": center_lon,
			"lat": center_lat,
		},
	}


def _extract_json_object_from_text(text: str) -> dict[str, Any] | None:
	if not text:
		return None
	trimmed = text.strip()
	for candidate in (trimmed,):
		try:
			obj = json.loads(candidate)
			return obj if isinstance(obj, dict) else None
		except Exception:
			pass
	start = trimmed.find("{")
	end = trimmed.rfind("}")
	if start >= 0 and end > start:
		snippet = trimmed[start : end + 1]
		try:
			obj = json.loads(snippet)
			return obj if isinstance(obj, dict) else None
		except Exception:
			return None
	return None


def _call_hydro_label_model(
	*,
	project: Project,
	rule_payload: dict[str, Any],
) -> dict[str, Any] | None:
	api_key, model_name, base_url = _resolve_hydro_model_config()
	if not api_key or not model_name:
		return None
	series = rule_payload.get("series") if isinstance(rule_payload.get("series"), list) else []
	if len(series) > 240:
		series = series[-240:]

	model_input = {
		"project": _build_project_geo_context(project),
		"flow": {
			"time_unit": rule_payload.get("time_unit", "hour"),
			"time_interval_hour": rule_payload.get("time_interval_hour", 1),
			"sample_count": len(series),
			"series": series,
			"peak_flow": rule_payload.get("peak_flow"),
			"peak_time": rule_payload.get("peak_time"),
			"current_flow": rule_payload.get("current_flow"),
			"current_time": rule_payload.get("current_time"),
			"avg_flow": rule_payload.get("avg_flow"),
		},
		"vocab": list(HYDRO_LABEL_VOCAB),
	}

	system_prompt = (
		"你是水文状态分类器。"
		"必须只从词库中选择一个标签：退水、涨水、泄洪、干枯、稳态。"
		"请综合流量曲线与地理上下文判断最接近的标签。"
		"地理信息里 center_wgs84 是大致经纬度。"
		"输出严格JSON对象："
		"{\"label\":\"<词库中的一个>\",\"confidence\":0到1小数,\"reason\":\"一句中文理由\"}"
	)

	request_payload = {
		"model": model_name,
		"temperature": 0.1,
		"messages": [
			{"role": "system", "content": system_prompt},
			{"role": "user", "content": json.dumps(model_input, ensure_ascii=False)},
		],
	}

	request_data = json.dumps(request_payload, ensure_ascii=False).encode("utf-8")
	req = urlrequest.Request(
		url=f"{base_url}/chat/completions",
		data=request_data,
		headers={
			"Authorization": f"Bearer {api_key}",
			"Content-Type": "application/json",
		},
		method="POST",
	)

	try:
		with urlrequest.urlopen(req, timeout=30) as resp:
			resp_text = resp.read().decode("utf-8")
	except (urlerror.URLError, TimeoutError, OSError):
		return None

	try:
		resp_json = json.loads(resp_text)
	except Exception:
		return None

	choices = resp_json.get("choices") if isinstance(resp_json, dict) else None
	if not isinstance(choices, list) or not choices:
		return None
	message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
	content = message.get("content", "")
	if isinstance(content, list):
		parts = []
		for item in content:
			if isinstance(item, dict):
				text_part = item.get("text")
				if isinstance(text_part, str):
					parts.append(text_part)
		content = "\n".join(parts)
	if not isinstance(content, str):
		return None

	parsed = _extract_json_object_from_text(content)
	if not parsed:
		return None

	label = _normalize_hydro_label(parsed.get("label"))
	confidence = _clamp_confidence(parsed.get("confidence"), default=0.65)
	reason = str(parsed.get("reason") or "模型已完成判别。")
	return {
		"hydro_label": label,
		"confidence": confidence,
		"reason": reason,
		"label_source": "ai",
		"model_name": model_name,
	}


def _build_geo_insight_text(project: Project) -> str:
	geo_context = _build_project_geo_context(project)
	center = geo_context.get("center_wgs84") or {}
	center_lon = center.get("lon")
	center_lat = center.get("lat")
	if isinstance(center_lon, (int, float)) and isinstance(center_lat, (int, float)):
		if np.isfinite(center_lon) and np.isfinite(center_lat):
			return f"地理位置：项目中心约东经{float(center_lon):.2f}°、北纬{float(center_lat):.2f}°。"

	plane_center = geo_context.get("center") or {}
	center_x = plane_center.get("x")
	center_y = plane_center.get("y")
	if isinstance(center_x, (int, float)) and isinstance(center_y, (int, float)):
		if np.isfinite(center_x) and np.isfinite(center_y):
			return f"地理位置：中心平面坐标约为 x={float(center_x):.0f}, y={float(center_y):.0f}。"

	return "地理位置：坐标信息不足，暂无法估算中心经纬度。"


def _build_water_level_assessment_text(rule_payload: dict[str, Any]) -> str:
	current_flow_raw = rule_payload.get("current_flow")
	peak_flow_raw = rule_payload.get("peak_flow")
	avg_flow_raw = rule_payload.get("avg_flow")
	label = _normalize_hydro_label(rule_payload.get("hydro_label"))

	current_flow = float(current_flow_raw) if isinstance(current_flow_raw, (int, float)) else float("nan")
	peak_flow = float(peak_flow_raw) if isinstance(peak_flow_raw, (int, float)) else float("nan")
	avg_flow = float(avg_flow_raw) if isinstance(avg_flow_raw, (int, float)) else float("nan")

	if not np.isfinite(current_flow):
		return f"水位评价：缺少有效流量序列，暂按{label}态势看待。"

	if np.isfinite(peak_flow) and peak_flow > 0:
		ratio = current_flow / peak_flow
		if ratio >= 0.85:
			level_text = "高位"
		elif ratio >= 0.6:
			level_text = "中高位"
		elif ratio >= 0.35:
			level_text = "中位"
		else:
			level_text = "低位"
		return (
			f"水位评价：当前入流约{current_flow:.0f} m3/s，"
			f"相对峰值约{ratio * 100:.0f}%，处于{level_text}并呈{label}趋势。"
		)

	if np.isfinite(avg_flow) and avg_flow > 0:
		if current_flow >= avg_flow * 1.15:
			level_text = "偏高"
		elif current_flow <= avg_flow * 0.75:
			level_text = "偏低"
		else:
			level_text = "中位"
		return f"水位评价：当前入流约{current_flow:.0f} m3/s，相对均值处于{level_text}并呈{label}趋势。"

	return f"水位评价：当前入流约{current_flow:.0f} m3/s，整体以{label}态势为主。"


def _call_hydro_summary_model(
	*,
	project: Project,
	rule_payload: dict[str, Any],
) -> dict[str, Any] | None:
	api_key, model_name, base_url = _resolve_hydro_model_config()
	if not api_key or not model_name:
		return None

	series = rule_payload.get("series") if isinstance(rule_payload.get("series"), list) else []
	if len(series) > 168:
		series = series[-168:]

	geo_context = _build_project_geo_context(project)
	model_input = {
		"project": geo_context,
		"flow": {
			"time_unit": rule_payload.get("time_unit", "hour"),
			"time_interval_hour": rule_payload.get("time_interval_hour", 1),
			"sample_count": len(series),
			"series": series,
			"peak_flow": rule_payload.get("peak_flow"),
			"peak_time": rule_payload.get("peak_time"),
			"current_flow": rule_payload.get("current_flow"),
			"current_time": rule_payload.get("current_time"),
			"avg_flow": rule_payload.get("avg_flow"),
		},
		"rule_label": _normalize_hydro_label(rule_payload.get("hydro_label")),
	}

	system_prompt = (
		"你是水文分析助手。"
		"请根据流量曲线和项目地理信息，给出简洁、自然、可读的现场判断。"
		"必须输出JSON对象，格式为："
		"{\"summary\":\"一句核心判断\",\"geo\":\"一句地理提示，可为空\",\"water_level\":\"一句水位/流量评价\"}。"
		"允许措辞有变化，不要使用固定模板。"
		"整体文字保持短句，适配两行内阅读。"
	)

	request_payload = {
		"model": model_name,
		"temperature": _resolve_hydro_summary_temperature(),
		"messages": [
			{"role": "system", "content": system_prompt},
			{"role": "user", "content": json.dumps(model_input, ensure_ascii=False)},
		],
	}

	request_data = json.dumps(request_payload, ensure_ascii=False).encode("utf-8")
	req = urlrequest.Request(
		url=f"{base_url}/chat/completions",
		data=request_data,
		headers={
			"Authorization": f"Bearer {api_key}",
			"Content-Type": "application/json",
		},
		method="POST",
	)

	try:
		with urlrequest.urlopen(req, timeout=30) as resp:
			resp_text = resp.read().decode("utf-8")
	except (urlerror.URLError, TimeoutError, OSError):
		return None

	try:
		resp_json = json.loads(resp_text)
	except Exception:
		return None

	choices = resp_json.get("choices") if isinstance(resp_json, dict) else None
	if not isinstance(choices, list) or not choices:
		return None
	message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
	content = message.get("content", "")
	if isinstance(content, list):
		parts = []
		for item in content:
			if isinstance(item, dict):
				text_part = item.get("text")
				if isinstance(text_part, str):
					parts.append(text_part)
		content = "\n".join(parts)
	if not isinstance(content, str):
		return None

	parsed = _extract_json_object_from_text(content)
	if not parsed:
		return None

	summary_text = str(parsed.get("summary") or "").strip()
	geo_insight = str(parsed.get("geo") or "").strip()
	water_level_assessment = str(parsed.get("water_level") or "").strip()

	if not summary_text and not geo_insight and not water_level_assessment:
		return None

	return {
		"summary_text": summary_text or "AI 已完成本轮水动力摘要。",
		"geo_insight": geo_insight or _build_geo_insight_text(project),
		"water_level_assessment": water_level_assessment or _build_water_level_assessment_text(rule_payload),
		"source": "ai",
		"model_name": model_name,
	}


def _build_hydro_summary_fallback(project: Project, rule_payload: dict[str, Any]) -> dict[str, Any]:
	label = _normalize_hydro_label(rule_payload.get("hydro_label"))
	summary_text = f"当前水动力判定为{label}，建议持续关注未来6小时入流变化。"
	return {
		"summary_text": summary_text,
		"geo_insight": _build_geo_insight_text(project),
		"water_level_assessment": _build_water_level_assessment_text(rule_payload),
		"source": "rule-fallback",
		"model_name": None,
	}


def _compute_project_hydro_ai_summary(*, project: Project, db: Session) -> dict[str, Any]:
	project_hdf_path = Path(project.hdf_path).resolve()
	if not project_hdf_path.exists():
		return {
			"project_id": project.id,
			"found": False,
			"summary_text": "项目 HDF 文件不存在，无法进行 AI 概括。",
			"geo_insight": _build_geo_insight_text(project),
			"water_level_assessment": "水位评价：缺少可计算的流量数据。",
			"source": "rule-fallback",
			"model_name": None,
		}

	source_hdf_path = Path(project.flow_hdf_path).resolve() if project.flow_hdf_path else None
	flow_hydrograph_ref = project.flow_hydrograph_ref
	flow_time_ref = project.flow_time_ref

	need_refresh = (
		source_hdf_path is None
		or not source_hdf_path.exists()
		or not flow_hydrograph_ref
	)
	if need_refresh:
		source_hdf_path, flow_hydrograph_ref, flow_time_ref = _resolve_project_flow_source(project_hdf_path)
		if source_hdf_path and flow_hydrograph_ref:
			project.flow_hdf_path = str(source_hdf_path)
			project.flow_hydrograph_ref = flow_hydrograph_ref
			project.flow_time_ref = flow_time_ref
			db.add(project)
			try:
				db.commit()
			except Exception:
				db.rollback()

	if source_hdf_path is None or flow_hydrograph_ref is None:
		return {
			"project_id": project.id,
			"found": False,
			"summary_text": "未发现可用的上游非恒定流曲线，无法生成 AI 概括。",
			"geo_insight": _build_geo_insight_text(project),
			"water_level_assessment": "水位评价：暂缺入流曲线，建议先校验边界条件。",
			"source": "rule-fallback",
			"model_name": None,
		}

	rule_payload = _judge_hydro_label_from_source(
		source_hdf_path=source_hdf_path,
		flow_hydrograph_ref=flow_hydrograph_ref,
		flow_time_ref=flow_time_ref,
	)

	ai_summary = _call_hydro_summary_model(project=project, rule_payload=rule_payload)
	fallback_summary = _build_hydro_summary_fallback(project, rule_payload)
	summary_payload = ai_summary or fallback_summary
	geo_context = _build_project_geo_context(project)

	return {
		"project_id": project.id,
		"found": True,
		"hydro_label": _normalize_hydro_label(rule_payload.get("hydro_label")),
		"summary_text": summary_payload.get("summary_text"),
		"geo_insight": summary_payload.get("geo_insight"),
		"water_level_assessment": summary_payload.get("water_level_assessment"),
		"source": summary_payload.get("source"),
		"model_name": summary_payload.get("model_name"),
		"center_wgs84": geo_context.get("center_wgs84"),
		"current_flow": rule_payload.get("current_flow"),
		"peak_flow": rule_payload.get("peak_flow"),
	}


def _classify_hydro_state_from_series(series: list[list[float]]) -> dict[str, Any]:
	if not series:
		return {
			"hydro_label": "稳态",
			"confidence": 0.2,
			"reason": "缺少有效流量序列，默认按稳态处理。",
		}

	arr = np.asarray(series, dtype=np.float64)
	if arr.ndim != 2 or arr.shape[1] < 2:
		return {
			"hydro_label": "稳态",
			"confidence": 0.2,
			"reason": "流量序列结构异常，默认按稳态处理。",
		}

	time_axis = arr[:, 0]
	flow_abs = np.abs(arr[:, 1])
	if flow_abs.size == 0 or not np.isfinite(flow_abs).any():
		return {
			"hydro_label": "稳态",
			"confidence": 0.2,
			"reason": "流量序列无有效值，默认按稳态处理。",
		}

	q_start = float(flow_abs[0])
	q_end = float(flow_abs[-1])
	q_peak = float(np.nanmax(flow_abs))
	q_mean = float(np.nanmean(flow_abs))
	q_min = float(np.nanmin(flow_abs))
	peak_index = int(np.nanargmax(flow_abs))
	peak_time = float(time_axis[peak_index])

	recent_window = max(1, min(6, int(flow_abs.size - 1)))
	q_prev = float(flow_abs[-1 - recent_window]) if flow_abs.size > 1 else q_end
	delta_recent = q_end - q_prev
	delta_total = q_end - q_start

	trend_threshold = max(3.0, q_peak * 0.08)
	dry_threshold = max(1.0, q_peak * 0.06)

	if q_peak <= 1.0 or (q_end <= dry_threshold and q_mean <= max(25.0, q_peak * 0.35)):
		confidence = min(0.98, 0.7 + (dry_threshold - min(q_end, dry_threshold)) / max(dry_threshold, 1.0) * 0.25)
		label = "干枯"
		reason = (
			f"末时刻流量{q_end:.2f} m3/s，低于干枯阈值{dry_threshold:.2f} m3/s，"
			f"整体峰值{q_peak:.2f} m3/s。"
		)
	elif q_end >= max(q_peak * 0.82, q_mean * 1.25) and q_peak >= max(80.0, q_mean * 1.2):
		confidence = min(0.95, 0.6 + (q_end / max(q_peak, 1.0)) * 0.35)
		label = "泄洪"
		reason = (
			f"当前流量{q_end:.2f} m3/s接近峰值{q_peak:.2f} m3/s，"
			f"峰值出现在{peak_time:.0f}h，表现为高流量排放。"
		)
	elif delta_recent >= trend_threshold and delta_total > 0:
		confidence = min(0.95, 0.55 + abs(delta_recent) / max(q_peak, 1.0) * 1.2)
		label = "涨水"
		reason = (
			f"最近{recent_window}小时流量上升{delta_recent:.2f} m3/s，"
			f"较起始时刻累计上升{delta_total:.2f} m3/s。"
		)
	elif delta_recent <= -trend_threshold and delta_total < 0:
		confidence = min(0.95, 0.55 + abs(delta_recent) / max(q_peak, 1.0) * 1.2)
		label = "退水"
		reason = (
			f"最近{recent_window}小时流量下降{abs(delta_recent):.2f} m3/s，"
			f"较起始时刻累计下降{abs(delta_total):.2f} m3/s。"
		)
	else:
		volatility = float(np.std(flow_abs) / max(q_mean, 1.0))
		confidence = min(0.8, 0.45 + volatility * 0.35)
		label = "稳态"
		reason = (
			f"当前流量{q_end:.2f} m3/s，峰值{q_peak:.2f} m3/s，"
			f"最近变化幅度不显著。"
		)

	return {
		"hydro_label": _normalize_hydro_label(label),
		"confidence": float(max(0.0, min(1.0, confidence))),
		"reason": reason,
		"metrics": {
			"q_start": q_start,
			"q_end": q_end,
			"q_min": q_min,
			"q_mean": q_mean,
			"q_peak": q_peak,
			"peak_time": peak_time,
			"delta_recent": float(delta_recent),
			"delta_total": float(delta_total),
		},
	}


def _judge_hydro_label_from_source(
	*,
	source_hdf_path: Path,
	flow_hydrograph_ref: str,
	flow_time_ref: str | None,
) -> dict[str, Any]:
	series_payload = _extract_flow_hydrograph_series(
		hdf_path=source_hdf_path,
		flow_hydrograph_ref=flow_hydrograph_ref,
		flow_time_ref=flow_time_ref,
	)
	classification = _classify_hydro_state_from_series(series_payload.get("series", []))
	return {
		"source_hdf": str(source_hdf_path),
		"flow_hydrograph_ref": flow_hydrograph_ref,
		"flow_time_ref": flow_time_ref,
		**series_payload,
		**classification,
	}


def _compute_and_persist_project_hydro_label(
	*,
	project: Project,
	db: Session,
	force: bool = False,
	mode: str = "rule",
) -> dict[str, Any]:
	mode_normalized = str(mode).strip().lower()
	if mode_normalized not in {"rule", "ai", "hybrid"}:
		mode_normalized = "rule"

	if (
		not force
		and mode_normalized in {"rule", "hybrid"}
		and project.hydro_label
		and project.hydro_label_updated_at is not None
		and project.flow_hdf_path
		and project.flow_hydrograph_ref
	):
		return {
			"project_id": project.id,
			"found": True,
			"hydro_label": _normalize_hydro_label(project.hydro_label),
			"confidence": float(project.hydro_label_confidence or 0.0),
			"reason": "",
			"flow_hdf_path": project.flow_hdf_path,
			"flow_hydrograph_ref": project.flow_hydrograph_ref,
			"flow_time_ref": project.flow_time_ref,
			"mode": mode_normalized,
			"label_source": "cache",
			"cached": True,
		}

	project_hdf_path = Path(project.hdf_path).resolve()
	if not project_hdf_path.exists():
		project.hydro_label = "稳态"
		project.hydro_label_confidence = 0.2
		project.hydro_label_updated_at = datetime.now(timezone.utc)
		db.add(project)
		db.commit()
		return {
			"project_id": project.id,
			"found": False,
			"hydro_label": project.hydro_label,
			"confidence": float(project.hydro_label_confidence or 0.0),
			"reason": "项目HDF文件不存在，无法判断。",
			"mode": mode_normalized,
			"label_source": "rule",
			"cached": False,
		}

	source_hdf_path = Path(project.flow_hdf_path).resolve() if project.flow_hdf_path else None
	flow_hydrograph_ref = project.flow_hydrograph_ref
	flow_time_ref = project.flow_time_ref
	if source_hdf_path is None or not source_hdf_path.exists() or not flow_hydrograph_ref:
		source_hdf_path, flow_hydrograph_ref, flow_time_ref = _resolve_project_flow_source(project_hdf_path)

	if source_hdf_path is None or flow_hydrograph_ref is None:
		project.hydro_label = "稳态"
		project.hydro_label_confidence = 0.2
		project.hydro_label_updated_at = datetime.now(timezone.utc)
		db.add(project)
		db.commit()
		return {
			"project_id": project.id,
			"found": False,
			"hydro_label": project.hydro_label,
			"confidence": float(project.hydro_label_confidence or 0.0),
			"reason": "未找到可用的上游非恒定流曲线。",
			"mode": mode_normalized,
			"label_source": "rule",
			"cached": False,
		}

	payload = _judge_hydro_label_from_source(
		source_hdf_path=source_hdf_path,
		flow_hydrograph_ref=flow_hydrograph_ref,
		flow_time_ref=flow_time_ref,
	)
	rule_label = _normalize_hydro_label(payload.get("hydro_label"))
	rule_confidence = _clamp_confidence(payload.get("confidence"), default=0.55)
	rule_reason = str(payload.get("reason") or "规则判别完成。")
	label_source = "rule"
	model_name = None
	final_label = rule_label
	final_confidence = rule_confidence
	final_reason = rule_reason

	if mode_normalized in {"ai", "hybrid"}:
		ai_result = _call_hydro_label_model(project=project, rule_payload=payload)
		if ai_result is not None:
			final_label = _normalize_hydro_label(ai_result.get("hydro_label"))
			final_confidence = _clamp_confidence(ai_result.get("confidence"), default=0.65)
			final_reason = str(ai_result.get("reason") or rule_reason)
			label_source = str(ai_result.get("label_source") or "ai")
			model_name = ai_result.get("model_name")
		elif mode_normalized == "ai":
			final_label = rule_label
			final_confidence = rule_confidence
			final_reason = f"AI不可用，已回退规则判别。{rule_reason}"
			label_source = "rule-fallback"

	project.flow_hdf_path = str(source_hdf_path)
	project.flow_hydrograph_ref = flow_hydrograph_ref
	project.flow_time_ref = flow_time_ref
	project.hydro_label = final_label
	project.hydro_label_confidence = final_confidence
	project.hydro_label_updated_at = datetime.now(timezone.utc)
	db.add(project)
	db.commit()

	return {
		"project_id": project.id,
		"found": True,
		"hydro_label": project.hydro_label,
		"confidence": float(project.hydro_label_confidence or 0.0),
		"reason": final_reason,
		"mode": mode_normalized,
		"label_source": label_source,
		"model_name": model_name,
		"flow_hdf_path": project.flow_hdf_path,
		"flow_hydrograph_ref": project.flow_hydrograph_ref,
		"flow_time_ref": project.flow_time_ref,
		"cached": False,
		"sample_count": payload.get("sample_count"),
		"peak_flow": payload.get("peak_flow"),
		"peak_time": payload.get("peak_time"),
		"current_flow": payload.get("current_flow"),
		"current_time": payload.get("current_time"),
		"metrics": payload.get("metrics"),
	}


def _backfill_project_flow_metadata() -> None:
	with Session(engine) as db:
		projects = db.execute(select(Project)).scalars().all()
		updated = False
		for project in projects:
			if project.flow_hdf_path and project.flow_hydrograph_ref:
				continue
			project_hdf_path = Path(project.hdf_path).resolve()
			if not project_hdf_path.exists():
				continue
			source_hdf_path, flow_hydrograph_ref, flow_time_ref = _resolve_project_flow_source(project_hdf_path)
			if not source_hdf_path or not flow_hydrograph_ref:
				continue
			project.flow_hdf_path = str(source_hdf_path)
			project.flow_hydrograph_ref = flow_hydrograph_ref
			project.flow_time_ref = flow_time_ref
			updated = True
		if updated:
			db.commit()

		projects_need_label = db.execute(select(Project).where(Project.hydro_label.is_(None))).scalars().all()
		default_mode = _default_hydro_label_mode()
		for project in projects_need_label:
			try:
				_compute_and_persist_project_hydro_label(project=project, db=db, force=False, mode=default_mode)
			except Exception:
				db.rollback()


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
	_ensure_projects_table_columns()
	_prune_projects_table_columns()
	_backfill_project_flow_metadata()


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
		hydro_label = _normalize_hydro_label(project.hydro_label)

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
				"hydro_label": hydro_label,
				"hydro_label_confidence": project.hydro_label_confidence,
				"flow_ready": bool(project.flow_hdf_path and project.flow_hydrograph_ref),
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
	flow_hdf_path, flow_hydrograph_ref, flow_time_ref = _resolve_project_flow_source(hdf_file)

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
		flow_hdf_path=str(flow_hdf_path) if flow_hdf_path else None,
		flow_hydrograph_ref=flow_hydrograph_ref,
		flow_time_ref=flow_time_ref,
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

	try:
		_compute_and_persist_project_hydro_label(
			project=project,
			db=db,
			force=True,
			mode=_default_hydro_label_mode(),
		)
	except Exception:
		db.rollback()

	return {"ok": True, "project_id": project.id}


@app.get("/api/projects/{project_id}/flow-hydrograph")
def get_project_flow_hydrograph(
	project_id: int,
	db: Session = Depends(get_db),
) -> dict[str, Any]:
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	project_hdf_path = Path(project.hdf_path).resolve()
	if not project_hdf_path.exists():
		raise HTTPException(status_code=404, detail="Project HDF file not found")

	source_hdf_path = Path(project.flow_hdf_path).resolve() if project.flow_hdf_path else None
	flow_hydrograph_ref = project.flow_hydrograph_ref
	flow_time_ref = project.flow_time_ref

	need_refresh = (
		source_hdf_path is None
		or not source_hdf_path.exists()
		or not flow_hydrograph_ref
	)
	if need_refresh:
		source_hdf_path, flow_hydrograph_ref, flow_time_ref = _resolve_project_flow_source(project_hdf_path)
		if not source_hdf_path or not flow_hydrograph_ref:
			return {
				"project_id": project_id,
				"found": False,
				"message": "未在 u01/g01/hdf/p01 中发现上游非恒定流边界曲线。",
			}

		project.flow_hdf_path = str(source_hdf_path)
		project.flow_hydrograph_ref = flow_hydrograph_ref
		project.flow_time_ref = flow_time_ref
		db.add(project)
		try:
			db.commit()
		except Exception:
			db.rollback()

	if source_hdf_path is None or flow_hydrograph_ref is None:
		return {
			"project_id": project_id,
			"found": False,
			"message": "流量曲线配置为空。",
		}

	series_payload = _extract_flow_hydrograph_series(
		hdf_path=source_hdf_path,
		flow_hydrograph_ref=flow_hydrograph_ref,
		flow_time_ref=flow_time_ref,
	)
	return {
		"project_id": project_id,
		"found": True,
		"source_hdf": str(source_hdf_path),
		"flow_hydrograph_ref": flow_hydrograph_ref,
		"flow_time_ref": flow_time_ref,
		**series_payload,
	}


@app.get("/api/projects/{project_id}/hydro-ai-summary")
def get_project_hydro_ai_summary(
	project_id: int,
	response: FastAPIResponse,
	db: Session = Depends(get_db),
) -> dict[str, Any]:
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
	response.headers["Pragma"] = "no-cache"
	response.headers["Expires"] = "0"

	return _compute_project_hydro_ai_summary(project=project, db=db)


@app.post("/api/projects/{project_id}/hydro-label/judge")
def judge_project_hydro_label(
	project_id: int,
	force: bool = Query(default=False),
	mode: str | None = Query(default=None, pattern="^(rule|ai|hybrid)$"),
	db: Session = Depends(get_db),
) -> dict[str, Any]:
	project = db.get(Project, project_id)
	if project is None:
		raise HTTPException(status_code=404, detail="Project not found")

	effective_mode = mode or _default_hydro_label_mode()
	result = _compute_and_persist_project_hydro_label(project=project, db=db, force=force, mode=effective_mode)
	return result


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
	cell_surface_area_ref = CELL_SURFACE_AREA_REF

	static_data = _get_hdf_static_data(
		hdf_path=hdf_path,
		cell_center_ref=cell_center_ref,
		bed_elevation_ref=bed_elevation_ref,
		water_surface_ref=water_surface_ref,
		cell_surface_area_ref=cell_surface_area_ref,
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
	cell_surface_area = static_data.get("cell_surface_area")
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
				"cell_surface_area_ref": cell_surface_area_ref,
				"face_point_coordinate_ref": face_point_coordinate_ref,
				"face_point_indexes_ref": face_point_indexes_ref,
				"face_velocity_ref": face_velocity_ref,
			},
			"flood_area_square_meter": 0.0,
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

	wet_mask = finite_mask & (depth > min_depth)

	valid_indices = np.flatnonzero(valid_mask)
	wet_indices = np.flatnonzero(wet_mask)
	valid_count = int(valid_indices.size)
	flood_area_square_meter = 0.0
	if isinstance(cell_surface_area, np.ndarray) and cell_surface_area.ndim == 1:
		if int(cell_surface_area.shape[0]) == cell_count and int(wet_indices.size) > 0:
			wet_cell_area = np.asarray(cell_surface_area[wet_indices], dtype=np.float64)
			wet_cell_area = wet_cell_area[np.isfinite(wet_cell_area) & (wet_cell_area > 0)]
			if wet_cell_area.size > 0:
				flood_area_square_meter = float(np.sum(wet_cell_area))
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
				"cell_surface_area_ref": cell_surface_area_ref,
				"face_point_coordinate_ref": face_point_coordinate_ref,
				"face_point_indexes_ref": face_point_indexes_ref,
				"face_velocity_ref": face_velocity_ref,
				"include_dry": include_dry,
				"min_depth": float(min_depth),
			},
			"flood_area_square_meter": 0.0,
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
		f"flood_area={flood_area_square_meter:.2f}m2 "
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
		"flood_area_square_meter": float(flood_area_square_meter),
		"stride": stride,
		"metadata": {
			"source": str(project.hdf_path),
			"cell_center_ref": cell_center_ref,
			"bed_elevation_ref": bed_elevation_ref,
			"water_surface_ref": water_surface_ref,
			"cell_surface_area_ref": cell_surface_area_ref,
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
