from __future__ import annotations

from pathlib import Path

import h5py
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


BASE_DIR = Path(__file__).resolve().parent.parent
HDF_PATH = BASE_DIR / "resource" / "hdf" / "shuiku.p01.hdf"
OUTPUT_PATH = BASE_DIR / "resource" / "cache" / "mesh_centers_scatter.png"
OVERLAY_OUTPUT_PATH = BASE_DIR / "resource" / "cache" / "mesh_and_face_centers_overlay.png"
COORDS_PATH = "Geometry/2D Flow Areas/Perimeter 1/Cells Center Coordinate"
FACE_POINTS_PATH = "Geometry/2D Flow Areas/Perimeter 1/FacePoints Coordinate"
FACE_INDEXES_PATH = "Geometry/2D Flow Areas/Perimeter 1/Faces FacePoint Indexes"


def main() -> None:
    with h5py.File(HDF_PATH, "r") as hdf:
        coords = hdf[COORDS_PATH][:]
        face_points = hdf[FACE_POINTS_PATH][:]
        face_indexes = hdf[FACE_INDEXES_PATH][:]

    face_centers = (face_points[face_indexes[:, 0]] + face_points[face_indexes[:, 1]]) / 2.0

    x = coords[:, 0]
    y = coords[:, 1]
    fx = face_centers[:, 0]
    fy = face_centers[:, 1]

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    plt.figure(figsize=(8, 6), dpi=180)
    plt.scatter(x, y, s=2, alpha=0.7, linewidths=0)
    plt.title("Mesh Center Coordinates")
    plt.xlabel("X")
    plt.ylabel("Y")
    plt.axis("equal")
    plt.tight_layout()
    plt.savefig(OUTPUT_PATH)
    plt.close()

    plt.figure(figsize=(8, 6), dpi=180)
    plt.scatter(x, y, s=2, alpha=0.35, linewidths=0, label="Cell centers")
    plt.scatter(fx, fy, s=1.2, alpha=0.35, linewidths=0, label="Face centers")
    plt.title("Cell Centers and Face Centers")
    plt.xlabel("X")
    plt.ylabel("Y")
    plt.axis("equal")
    plt.legend(loc="best")
    plt.tight_layout()
    plt.savefig(OVERLAY_OUTPUT_PATH)
    plt.close()

    print(f"saved: {OUTPUT_PATH}")
    print(f"saved: {OVERLAY_OUTPUT_PATH}")
    print(f"point_count: {len(coords)}")
    print(f"face_count: {len(face_centers)}")


if __name__ == "__main__":
    main()