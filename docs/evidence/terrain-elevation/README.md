# Terrain Elevation — browser verification evidence

Captured for #3. A headless Chromium at 1400x900 loads the static site from a
local HTTP server, uploads a synthesized geotagged ZIP of central London, and
waits for the Overpass and Open-Meteo lookups to land.

Reproduce:

```sh
python3 scripts/make-geotagged-zip.py test_photos.zip
python3 -m http.server 8765
# upload test_photos.zip at http://localhost:8765/
```

Test area: a 300 m box around 51.5007, -0.1246 (Palace of Westminster /
Big Ben). The ground slopes ~20 m across the box (5–26 m ASL), so the lift is
visible as well as measurable.

## Result

Working path:

- One batched request against `api.open-meteo.com/v1/elevation` carried the
  Dataset Centroid plus every building centroid (single GET,
  `latitude=…&longitude=…` arrays) — no per-building fan-out. (49 centroids in
  the first pass, 37 in the re-run: Overpass returns a slightly different set
  per query.)
- Every rendered building now sits with its base on the scene's Ground
  Reference — the Terrain Elevation under the Dataset Centroid (docs/adr/0006).
  On this site the reference is 8 m ASL, so bases land at roughly −3…18 m
  *relative to the flat ground plane* (e.g. Big Ben, 96 m tall, base near 0 →
  roof near 96) rather than at their absolute 5–26 m ASL. Building positions
  are re-based so the ground plane's `y = 0` is the real local ground; the
  absolute sea-level frame is not used for placement. Verified on the ADR-0005
  true-metre scene frame (`horizontalScale = 0.6225`).
- Photo bubbles are untouched: still at `y = 35` (EXIF `GPSAltitude`). Per
  docs/adr/0003 the EXIF altitude datum is ambiguous, so it is deliberately not
  re-based against the DEM.
- No photo-relative readout ("above ground" / "above roof") is computed or
  displayed anywhere — ADR-0003 holds.

Failure path (terrain fetch blocked at the network layer):

- All buildings still render, every one on the flat ground plane
  (`terrain: null`, base at 0) — byte-for-byte the pre-change behaviour.
- The upload completes, the status line stays green, and only a console warning
  records the degradation. No error is shown to the user.

## Images

| File | Shows |
| --- | --- |
| `01-after-upload-terrain-lift.png` | Bubbles at 35 m; buildings standing on the ground plane, bases spread across the sloping site. |
| `03-terrain-failure-buildings-at-sea-level.png` | Same upload with the elevation fetch blocked: buildings collapsed to the flat ground plane, upload still succeeds. |

## Notes

- The DEM (Copernicus GLO-90, ~90 m resolution) is a surface model that
  includes buildings and vegetation. Its values are used only to sit buildings
  on the land, per docs/adr/0003. Slight under/overshoot against a building's
  true local ground is expected and accepted.
- The elevation request is fired after the photos are on screen and is not
  awaited by the upload flow; it cannot delay the bubbles.
