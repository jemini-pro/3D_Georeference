#!/usr/bin/env python3
"""Synthesize a tiny geotagged photo ZIP for exercising the Building Layer.

The browser pass for the Building Layer needs a ZIP of photos whose EXIF
carries GPS (and a heading, so the camera frustums are visible). Real drone
archives are large and rarely shareable, so this produces a 2 KB stand-in
instead: three solid-colour JPEGs around a landmark, named exactly as the
app's unzip pass expects.

Requires Pillow and piexif: `pip install pillow piexif`.

Usage:
    python3 scripts/make-geotagged-zip.py [out.zip]

Defaults to `test_photos.zip` in the working directory (gitignored). Upload
the result through the app's file input; it plots three bubbles in central
London.
"""

import io
import os
import sys
import zipfile

from PIL import Image
import piexif

# Central London: the Palace of Westminster / Big Ben, which is densely
# mapped in OpenStreetMap and contains multipolygon footprints with
# courtyards, so the hole triangulation is exercised too.
PHOTOS = [
    ("IMG_0001.jpg", 51.5007, -0.1246, 35.0, 90.0),
    ("IMG_0002.jpg", 51.5012, -0.1240, 35.0, 180.0),
    ("IMG_0003.jpg", 51.5003, -0.1252, 35.0, 270.0),
]


def deg_to_dms_rational(deg):
    """Decimal degrees -> the ((d,1),(m,1),(s,100)) EXIF rational form."""
    d = int(abs(deg))
    minutes_float = (abs(deg) - d) * 60
    m = int(minutes_float)
    s = round((minutes_float - m) * 60 * 100)
    return ((d, 1), (m, 1), (s, 100))


def make_photo(lat, lon, alt, heading):
    """A solid-colour JPEG carrying GPS lat/lon/alt and a heading."""
    img = Image.new("RGB", (320, 240), (80, 120, 160))
    exif_dict = {
        "0th": {piexif.ImageIFD.Make: b"GeoMapperFixture"},
        "Exif": {},
        "GPS": {
            piexif.GPSIFD.GPSLatitudeRef: b"N" if lat >= 0 else b"S",
            piexif.GPSIFD.GPSLatitude: deg_to_dms_rational(lat),
            piexif.GPSIFD.GPSLongitudeRef: b"E" if lon >= 0 else b"W",
            piexif.GPSIFD.GPSLongitude: deg_to_dms_rational(lon),
            piexif.GPSIFD.GPSAltitudeRef: 0 if alt >= 0 else 1,
            piexif.GPSIFD.GPSAltitude: (int(abs(alt) * 100), 100),
            piexif.GPSIFD.GPSImgDirectionRef: b"T",
            piexif.GPSIFD.GPSImgDirection: (int(heading * 100), 100),
        },
    }
    out = io.BytesIO()
    img.save(out, format="jpeg", exif=piexif.dump(exif_dict))
    return out.getvalue()


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else "test_photos.zip"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for name, lat, lon, alt, heading in PHOTOS:
            z.writestr(name, make_photo(lat, lon, alt, heading))
    print(f"wrote {dest} ({os.path.getsize(dest)} bytes)")


if __name__ == "__main__":
    main()
