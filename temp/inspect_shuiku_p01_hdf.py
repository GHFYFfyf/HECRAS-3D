from __future__ import annotations

from pathlib import Path

import h5py


HDF_PATH = Path(__file__).resolve().parent.parent / "resource" / "hdf" / "shuiku.p01.hdf"


def print_attrs(obj: h5py.Group | h5py.Dataset, indent: str) -> None:
    for key, value in obj.attrs.items():
        print(f"{indent}@{key} = {value}")


def walk(name: str, obj: h5py.Group | h5py.Dataset) -> None:
    depth = name.count("/")
    indent = "  " * depth

    if isinstance(obj, h5py.Group):
        print(f"{indent}[G] {name or '/'}")
        print_attrs(obj, indent + "  ")
        return

    shape = obj.shape if obj.shape is not None else "scalar"
    dtype = obj.dtype
    print(f"{indent}[D] {name} shape={shape} dtype={dtype}")
    print_attrs(obj, indent + "  ")


def main() -> None:
    if not HDF_PATH.exists():
        raise FileNotFoundError(f"HDF file not found: {HDF_PATH}")

    print(f"Inspecting: {HDF_PATH}")
    with h5py.File(HDF_PATH, "r") as hdf:
        walk("/", hdf)
        hdf.visititems(walk)


if __name__ == "__main__":
    main()