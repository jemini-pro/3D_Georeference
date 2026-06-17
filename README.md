# GeoMapper 3D

Drag-and-drop visualizer for geotagged photos in **3D space** — upload a ZIP of
JPEGs and see your images plotted on a real-world map with altitude as Y and
a camera-direction frustum showing where each shot was pointed.

Built as a single-page Three.js app, no build step, no backend. All client-side.

**Live demo:** https://jem-cell.github.io/3D_Georeference/

![Screenshot: four geotagged photos plotted as bubbles on an OpenStreetMap ground plane with camera frustum arrows showing heading](./screenshot.png)

## Features

- **Upload a ZIP of JPEGs** — extracts EXIF GPS in the browser (no upload to any server).
- **3D bubbles** for each photo at its real-world Mercator position, scaled by altitude.
- **Camera frustum arrows** drawn from each bubble showing the heading the photo was taken (from `GPSImgDirection`).
- **OpenStreetMap ground overlay** — 5×5 tile grid at zoom 19 centred on your data.
- **Bubble controls** — size slider, colour picker, hover-to-highlight.
- **Click a bubble** to centre the camera on it.
- **Toggle map overlay** off for a clean dark-sky view.

## How it works

1. `JSZip` reads the uploaded archive in the browser.
2. `exif-js` pulls GPS latitude / longitude / altitude / heading from each JPEG.
3. Each image is projected from WGS84 to **Web Mercator** (relative to the
   dataset's centroid so the origin is at the scene centre).
4. A `THREE.Mesh` sphere is added at `(x, alt, z)` with an attached
   `LineSegments` frustum rotated by the EXIF heading.
5. The camera auto-fits the bounding box of all points.

### Why Web Mercator relative-to-centroid?

Absolute Mercator coordinates are 10⁷-metre numbers with no useful scene-scale
meaning. By subtracting the centroid's Mercator (with an antimeridian wrap so
points across the dateline stay close together) the data sits in a
comfortable metre-scale space, with `Y` free for altitude.

### Why a single global token for tile loads?

`TextureLoader.load()` is async. If the user picks a second ZIP while the
first's 25 tiles are still resolving, callbacks from the first batch would
add stale planes to the scene. A monotonic `tileLoadToken` makes each
callback detect its own obsolescence and dispose its texture instead.

## Running locally

```bash
git clone https://github.com/jem-cell/3D_Georeference.git
cd 3D_Georeference
python3 -m http.server 8000
# open http://localhost:8000/
```

Or any static-file server. There is no build step.

## Tech

- [Three.js](https://threejs.org/) r128 (CDN, with `OrbitControls`)
- [JSZip](https://stuk.github.io/jszip/) 3.10
- [exif-js](https://github.com/exif-js/exif-js)
- [OpenStreetMap](https://www.openstreetmap.org/) raster tiles (zoom 19)

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
- **Single ZIP per session**: re-uploading clears the scene and starts fresh.
- **Tiles are rate-limited by OSM.** If you hammer the upload button, tiles
  may temporarily fail to load — the bubbles still appear on a flat
  fallback grid.
