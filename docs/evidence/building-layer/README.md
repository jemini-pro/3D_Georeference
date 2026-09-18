# Building Layer — browser verification evidence

Captured for #2 / #17. A headless Chromium at 1400x900 loads the static site
from a local HTTP server, uploads a synthesized geotagged ZIP of central
London, and waits for the Overpass query to land.

Reproduce:

```sh
python3 scripts/make-geotagged-zip.py test_photos.zip
python3 -m http.server 8765
# upload test_photos.zip at http://localhost:8765/
```

Test area: a 300 m box around 51.5007, -0.1246 (Palace of Westminster /
Big Ben), where OSM has both `height` and `building:levels` buildings and
multipolygon courtyards.

Overpass answers intermittently (a 504 was observed during this pass), so
the happy-path capture retries; the failure captures use request
interception and are deterministic.

## Result

- 49 Overpass elements -> 37 rendered meshes (12 dropped: too narrow or
  unusable rings). Five rendered buildings carry courtyards, with 1 to 10
  inner rings each, rendered as holes rather than filled in.
- Height ladder exercised: 3 by `height` (incl. 96 m), 18 by
  `building:levels` x 3 m, 16 by the 6 m default.
- No north-south mirroring: a point 0.0005 deg north of centroid maps to
  scene `z` opposite a point south of it, matching `gpsToCartesian`; the
  east-west to north-south extent ratio equals `cos(lat)` (0.6225 at
  51.5 deg), as ADR-0002 requires.
- Bubbles, frustums and 25 ground tiles render unchanged alongside the
  buildings.
- Attribution stays visible with the map overlay off, and on a 390x844
  viewport sits below the scrolled controls, fully on screen.

## Images

| File | Shows |
| --- | --- |
| `01-before-upload.png` | Empty scene and the persistent OSM credit. |
| `02-after-upload-3d.png` | 3 bubbles around Big Ben; 37 building masses; courtyards hollow. |
| `03-map-overlay-off.png` | Credit still visible and buildings still drawn with the map overlay off. |
| `04-buildings-js-missing.png` | `buildings.js` aborted at the network: app still boots and plots photos, buildings absent. |
| `05-overpass-failure.png` | Overpass aborted: photos render, status stays green, console warning only, no buildings. |
| `06-narrow-viewport.png` | 390x844 bottom-sheet layout: credit on screen, below the controls, covering nothing. |

## Known limitation

A multipolygon whose outer ring is split across several member ways is not
stitched: `parseBuildingRelation` treats each `outer`-role way as a
complete ring, so fragments shorter than three points are dropped and the
building disappears. The central-London relations used here have
single-way outer rings, so this did not affect the pass. Fixing it is a
candidate for the Building Layer documentation/hardening work, not #2's
tracer bullet.
