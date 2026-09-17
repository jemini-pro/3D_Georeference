# 0001 — Building geometry comes from OSM via Overpass, not from Google 3D Tiles

Status: accepted

## Context

We want real 3D building masses in the 3D scene so that photos can be read
relative to the structure they were shot around. The obvious source is
Google's Photorealistic 3D Tiles, which look far better than anything else
available globally. We looked hard at it and rejected it.

## Decision

Building geometry is derived client-side from OpenStreetMap: a single Overpass
bbox query for the area around the Dataset Centroid, extruded into meshes in
Scene Space.

## Why not Google Photorealistic 3D Tiles

We rejected the best-looking option for four independent reasons, any one of
which would have been enough:

- **It is not open data.** The Map Tiles API Policies forbid pre-fetching,
  caching, offline use, and geodata extraction — and positioning photos
  relative to a building requires holding the geometry.
- **It needs an API key and a billing account** with a 1,000-event monthly
  free cap, which breaks the app's no-backend, no-key, no-build-step shape.
- **It needs CesiumJS**, not the Three.js r128 scene the app is built on.
- **EEA developers get different, more restrictive terms** and may not be
  served some content.

## Consequences

OSM height coverage is thin and geographically skewed — roughly 3.5% of
building ways carry `height` and roughly 6% carry `building:levels`, with
central Europe far denser than everywhere else. Most buildings in most places
will therefore be flat-extruded boxes with a fallback height rather than
faithful 3D. We accept boxy-but-correct over photorealistic-but-unusable.

Overpass is a shared community resource with a documented usage policy, so the
app must make at most one small-bbox query per upload and cache the result. It
is not a tile server and must not be queried per photo or per camera move.

## Considered alternatives

- **Cesium OSM Buildings** (ion) — good global coverage and real roof geometry,
  but needs an ion token and CesiumJS rather than Three.js r128.
- **Pre-baked glTF from OSM2World** — bakes the hard geometry offline and loads
  with `GLTFLoader`, but freezes the scene to one prepared location.
- **MapLibre GL `fill-extrusion`** — keyless and open, but a second renderer
  alongside Three.js rather than an addition to the existing scene.
