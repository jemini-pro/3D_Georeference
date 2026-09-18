# 0005 — Scene Space is true metres; the frame is scaled as a whole

Status: accepted

## Context

ADR-0002 shrunk building footprints by `cos(latitude)` into true metres while
leaving the rest of the scene — ground tiles, photo bubbles, photo-to-photo
distances — in Mercator-inflated metres. The buildings' proportions were
correct, but the two layers disagreed in scale: at 51.5° (London) every 3D
model was ~38% smaller than the same building drawn on the map tile underneath
it. The models "sat" on the map, but were visibly smaller than the buildings
the map showed.

Two layers in one scene can live on two conventions only if nobody ever
compares them directly. The Building Layer's whole purpose is to be compared
directly with the map, so that tension had to resolve.

## Decision

Scene Space is now true metres, end to end. On upload, the app computes one
frame scale, `cos(centroid latitude)`, and applies it to **every** horizontal
offset in the scene about the Dataset Centroid:

- photo bubble positions (`gpsToCartesian`),
- ground tile extents and placements (`tileSceneGeometry`),
- building footprints (`footprintToScene` / `buildBuildingShapes`).

Altitudes and building heights are true metres already and are never scaled.
ADR-0002's per-footprint shrink is superseded: the scale it applied to
footprints is now applied to the whole frame, which is why footprints scale
about the scene origin, not their own centre.

## Why this side of the trade-off

The alternative — keeping the Mercator frame and un-shrinking footprints so
they match the map — makes buildings squat (proportions wrong against their
true-metre heights), and leaves photo bubbles offset from the map features
they belong to. Scaling the frame fixes both at once, and it is the same
multiply applied three times, so there is one number to reason about.

The cost is that photo-to-photo horizontal distances are no longer what the
raw projection gives — they are true metres, which is what a "3D georeference"
user actually wants to measure.

## Consequences

- One scale factor (`window.horizontalScale`) is computed per upload and
  shared by every horizontal placement in the scene. All horizontal maths
  must go through it; a stray raw Mercator offset would be 1.6× out in
  London and drift grows with latitude.
- ADR-0002 is superseded; its footprint-only shrink must not be reintroduced.
- `gpsToCartesian`, `tileSceneGeometry` and `footprintToScene` accept an
  optional `horizontalScale` (default 1), so the pure math stays testable
  and callers without a scale get the old behaviour.
- The rubble filter's 4 m threshold is true metres, exactly as it was before.
