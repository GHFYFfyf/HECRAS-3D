from __future__ import annotations

from pathlib import Path

import h5py
import numpy as np
import rasterio


BASE_DIR = Path(__file__).resolve().parent.parent
HDF_PATH = BASE_DIR / "resource" / "hdf" / "shuiku.p01.hdf"
TIF_PATH = BASE_DIR / "resource" / "hdf" / "shuiku.sk.tif"
COORDS_PATH = "Geometry/2D Flow Areas/Perimeter 1/Cells Center Coordinate"
BED_PATH = "Geometry/2D Flow Areas/Perimeter 1/Cells Minimum Elevation"


def main() -> None:
    with h5py.File(HDF_PATH, "r") as hdf:
        coords = hdf[COORDS_PATH][:]
        bed = hdf[BED_PATH][:]

    with rasterio.open(TIF_PATH) as src:
        transform = src.transform
        bounds = src.bounds
        width = src.width
        height = src.height
        crs = src.crs
        nodata = src.nodata

        inv = ~transform
        pixel_positions = np.array([inv * (float(x), float(y)) for x, y in coords])
        cols = pixel_positions[:, 0]
        rows = pixel_positions[:, 1]

        within = (
            (cols >= 0.0)
            & (cols <= width)
            & (rows >= 0.0)
            & (rows <= height)
        )

        col_center_match = np.isclose(cols - np.floor(cols), 0.5, atol=1e-6)
        row_center_match = np.isclose(rows - np.floor(rows), 0.5, atol=1e-6)
        center_match = within & col_center_match & row_center_match

        sampled = np.array(list(src.sample([(float(x), float(y)) for x, y in coords[:10]])))

        print(f"tif_path: {TIF_PATH}")
        print(f"tif_crs: {crs}")
        print(f"tif_bounds: {bounds}")
        print(f"tif_size: width={width}, height={height}")
        print(f"tif_res: x={transform.a}, y={transform.e}")
        print(f"tif_nodata: {nodata}")
        print()
        print(f"bed_point_count: {len(coords)}")
        print(f"points_within_tif: {int(within.sum())}")
        print(f"bed_points_on_tif_pixel_centers: {int(center_match.sum())}")
        print()
        print("first_10_bed_points_vs_tif_samples:")
        for index, ((x, y), bed_value, tif_value, on_center) in enumerate(
            zip(coords[:10], bed[:10], sampled[:, 0], center_match[:10], strict=False),
        ):
            print(
                f"  {index}: x={x}, y={y}, bed={bed_value}, tif_sample={tif_value}, on_tif_center={bool(on_center)}",
            )


if __name__ == "__main__":
    main()