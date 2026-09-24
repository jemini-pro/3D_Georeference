# 0006 — Buildings are based on one Ground Reference, not absolute sea level

Status: accepted

## Context

ADR-0002/0005 resolved the horizontal frame; this is the vertical one. Terrain
Elevation from the keyless DEM is metres **above sea level**, so the first
Terrain Elevation implementation set each building's base to its absolute
value: `mesh.position.y = building.terrain`. On the London fixture (ground
6–21 m, photos 35 m) that looked right, so it shipped.

It is wrong on any site that is not near sea level. The 3D scene's ground
tiles sit on a flat plane at `y = 0`, and photo heights enter at their raw EXIF
value. A building based at absolute metres floats above that plane by the
site's altitude, and can tower above the cameras: on a 1597 m site a 6 m
building's base landed ~1600 m up, roughly 1570 m above a camera whose EXIF
altitude read 25 m.

Two absolute-datum layers in one flat-plane scene can only agree while the
site is near sea level — the same shape of bug ADR-0002 fixed horizontally.

## Decision

Resolve the scene's **Ground Reference** once per upload: the Terrain
Elevation under the Dataset Centroid. Re-base every building base onto it —

```
building base y = terrain(building) − terrain(Dataset Centroid)
```

— so the reference maps to 0, the flat ground plane. `rebaseElevations()` in
terrain.js does the subtraction; the centroid's absolute value is kept on
`window.groundReference` for debugging. One extra coordinate rides along in
the same batched elevation request, so this costs no additional fetch.

Photo heights are left exactly as EXIF reports them. Per ADR-0003 the EXIF
altitude datum is ambiguous (ellipsoidal or mean sea level, device-dependent),
so reinterpreting it against the DEM would trade one silent bug for another;
the DEM is used only to place buildings on the land, as before.

## Why this side of the trade-off

The alternative — subtracting the Ground Reference from photo heights as well
— moves buildings and cameras by the *same constant*, so it changes neither
their relative positions nor the symptom, while pushing cameras below the
ground whenever EXIF altitude is above-ground rather than above sea level.
Re-basing only building bases puts every building on the plane the tiles
already occupy, and leaves the one datum we cannot trust untouched.

## Consequences

- All building bases are relative to one per-upload Ground Reference; genuine
  local relief (a hillside) survives as the difference between each building's
  elevation and the centroid's.
- A building below the reference (downhill from the centroid) gets a negative
  base and sits slightly under the plane. This is the honest reading of a flat
  plane standing in for sloped ground and is accepted.
- If the Ground Reference is unresolved, every building base resolves to
  `null` and the whole Building Layer sits on the plane — never a guessed
  offset (docs/adr/0003's graceful-degradation rule).
- The 2D coverage map is unaffected; it has no vertical axis.
