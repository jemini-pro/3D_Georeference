# GeoMapper 3D

Drag-and-drop visualizer for geotagged photos in **3D space** — upload a ZIP of
JPEGs and see your images plotted on a real-world map with altitude as Y and
a camera-direction frustum showing where each shot was pointed.

For large archives (drone dumps, surveys, exports of thousands of photos) the
app automatically falls back to a fast **2D coverage map** that scales to
30 000+ points without breaking a sweat.

Built as a single-page app, no build step, no backend. All client-side.

**Live demo:** https://jemini-pro.github.io/3D_Georeference/

![Screenshot: geotagged photos plotted as bubbles on an OpenStreetMap ground plane with camera frustum arrows showing heading](./screenshot.png)

## Two modes, auto-selected

The app picks the right visualisation based on what you upload:

| Mode | When | What you get |
|------|------|--------------|
| **3D scene** | < 2 000 photos and < 500 MB | Three.js + OSM ground tiles. Bubbles with altitude as Y, camera frustum arrows showing heading, hover-to-highlight, click-to-centre. |
| **2D coverage map** | > 2 000 photos or > 500 MB | Leaflet + 5×5 OSM tiles. Every photo as a dot. Optional density heatmap. Renders 30 000 points in seconds. |

You don't choose — the app picks based on your file. Same input, different
output. Both modes share the same EXIF parsing and lat/lng projection.

## Features

- **Upload a ZIP of JPEGs** — extracts EXIF GPS in the browser (no upload to any server).
- **3D bubbles** for each photo at its real-world Mercator position, scaled by altitude (3D mode).
- **Camera frustum arrows** drawn from each bubble showing the heading the photo was taken (3D mode).
- **OpenStreetMap ground overlay** — 5×5 tile grid at zoom 19 centred on your data.
- **Building masses** stand on the real terrain — ground height under each
  building is resolved from the keyless Copernicus DEM (Open-Meteo), so bubbles
  and roofs share the same metres-above-sea-level frame.
- **Bubble controls** — size slider, colour picker, hover-to-highlight (3D mode).
- **Click a bubble** to centre the camera on it (3D mode).
- **Density heatmap** toggle for the 2D map.

## Drone / large-archive workflow

DJI / Autel exports and most drone survey ZIPs trigger the 2D mode automatically
once you exceed 2 000 photos or 500 MB. The 2D view is built for "did my
survey cover the right area?" — it loads in seconds and pans/zooms smoothly
even with 30 000 dots.

**Tip:** If you want to see specific shots in 3D from a drone dump, take a
small subsample (50-100 photos) and zip just that. The app will pick 3D mode
for the small archive.

**Known limit:** ZIPs over 2 GB fail with a clear error message instead of
silently crashing the tab. Workaround: split your drone export into chunks
of < 2 GB on your machine (e.g. `zip -s 1500m archive.zip original/`) and
upload each chunk separately. Truly streaming > 2 GB archives would require
reading the End-of-Central-Directory record from the file's tail and using
`File.slice` to read the central directory on demand — possible but a
bigger refactor; the current chunk-and-upload path is good enough.

## How it works

1. `fflate.unzipSync` reads the archive with a `filter` callback. Videos
   (`.mp4`, `.mov`, `.lrv`, …) and any file over 25 MB are skipped during
   the unzip pass — they're never even inflated, which is what makes
   multi-GB drone archives practical.
2. `exif-js` pulls GPS latitude / longitude / altitude / heading from each
   kept JPEG.
3. The 3D path projects each image from WGS84 to **Web Mercator** (relative
   to the dataset's centroid so the origin is at the scene centre) and adds
   a `THREE.Mesh` sphere with a `LineSegments` frustum.
4. The 2D path adds each photo as a `L.circleMarker` with a hover tooltip.
5. The 3D path lifts each building onto its Terrain Elevation — ground height
   above sea level from the keyless Open-Meteo Copernicus DEM endpoint, batched
   at up to 100 centroids per request. A failed lookup degrades to the flat
   sea-level ground; it never fails or delays the upload (docs/adr/0003).
6. The camera / map auto-fits the bounding box of all points.

### Why Web Mercator relative-to-centroid?

Absolute Mercator coordinates are 10⁷-metre numbers with no useful scene-scale
meaning. By subtracting the centroid's Mercator (with an antimeridian wrap so
points across the dateline stay close together) the data sits in a
comfortable metre-scale space, with `Y` free for altitude.

### Why fflate and not JSZip?

JSZip loads the whole archive into memory before yielding any entries.
A 5 GB drone export won't fit in V8's per-tab heap on an 8 GB Mac. fflate
exposes a `filter` callback that runs on entry metadata *before* the bytes
are decompressed, so we can skip videos and oversized files without ever
inflating them. Bundle size is 8 kB vs JSZip's 100 kB.

### Why a single global token for tile loads?

`TextureLoader.load()` is async. If the user picks a second ZIP while the
first's 25 tiles are still resolving, callbacks from the first batch would
add stale planes to the scene. A monotonic `tileLoadToken` makes each
callback detect its own obsolescence and dispose its texture instead.

## Running locally

```bash
git clone https://github.com/jemini-pro/3D_Georeference.git
cd 3D_Georeference
python3 -m http.server 8000
# open http://localhost:8000/
```

Or any static-file server. There is no build step.

### Running the tests

The pure logic modules (`projection.js`, `buildings.js`, `terrain.js`) have
zero-dependency tests using Node's built-in test runner:

```bash
node --test
```

This is what CI runs. To try the app end-to-end without a real drone archive,
synthesize a small geotagged ZIP around Big Ben:

```bash
pip install pillow piexif
python3 scripts/make-geotagged-zip.py test_photos.zip
# then upload test_photos.zip through the app's file input
```

## Tech

- [Three.js](https://threejs.org/) r128 (CDN, with `OrbitControls`) — 3D mode
- [fflate](https://github.com/101arrowz/fflate) 0.8 — streaming ZIP with filter
- [exif-js](https://github.com/exif-js/exif-js) — EXIF GPS parsing
- [Leaflet](https://leafletjs.com/) 1.9 — 2D mode
- [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) — density heatmap
- [OpenStreetMap](https://www.openstreetmap.org/) raster tiles (zoom 19) — both modes

No npm, no bundler, no framework.

## Attribution & licence

Map tiles © OpenStreetMap contributors — used under the
[ODbL](https://www.openstreetmap.org/copyright). Please follow the OSM
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/) if
you self-host or extend this project.

Code: MIT — see [LICENSE](./LICENSE).

## Browser support

Tested on current Chrome, Safari, and Firefox. iOS Safari occasionally
invalidates the `File` handle when the picker closes — handled by reading
the file into an `ArrayBuffer` immediately.

## Known limitations

- **HEIC** images: the EXIF parser handles some but not all; affected files
  are warned to the console and skipped.
- **Mercator at the poles**: Web Mercator is undefined above ~85°.0511°
  latitude; latitudes are clamped, so polar photos will cluster at the
  clamp line.
- **2 GB ZIP cap**: archives larger than 2 GB need to be split on your end
  (see "Drone / large-archive workflow" above).
- **OSM tile rate limits**: hammering the upload button will cause tiles to
  fail; the bubbles still appear on a flat fallback grid.
