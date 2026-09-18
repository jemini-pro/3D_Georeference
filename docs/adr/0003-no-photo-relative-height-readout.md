# 0003 — No photo-relative height readout, even though we can compute one

Status: accepted

## Context

Once buildings stand in the scene it becomes possible to compare a photo's
Altitude against the Terrain Elevation under it and the Building Height beside
it, and to display something like "12 m above roof level". We can compute a
number. We are choosing not to show it.

## Decision

Terrain Elevation is fetched, but only to sit buildings on the land. No
photo-relative height figure is derived from it or shown to the user.

## Why

The terrain models available to us keylessly are not accurate enough to stand
behind a displayed number:

- The keyless global option (Open-Meteo, Copernicus DEM GLO-90) resolves at
  roughly 90 metres. A single building is sub-pixel at that scale, so the
  value returned reflects a mix of roofs, trees and ground over a 90 m
  footprint. Measured against SRTM for the same point, the two disagreed by
  8 metres.
- These are *surface* models — they include buildings and vegetation — so
  adding Building Height on top of Terrain Elevation double-counts structures.
- EXIF `GPSAltitude` is itself inconsistent across cameras, and is variously
  ellipsoidal or above mean sea level depending on the device. The two cannot
  be compared without knowing which.

Any single one of these makes the figure unreliable; together they make it
misleading, and a plausible-looking wrong number is worse than no number.

## Consequences

The building layer stays a purely visual reference, which matches the
resolution reached on photo/building correspondence: buildings exist to make
photo poses legible by eye, not to be measured against.

If a future change adds a proper bare-earth digital terrain model — for
example a national LiDAR dataset with a stated vertical accuracy — this
decision should be revisited rather than treated as permanent. The blocker is
data quality, not design.
