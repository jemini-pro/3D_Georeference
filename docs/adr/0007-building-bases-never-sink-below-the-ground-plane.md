# 0007 — Building bases never sit below the ground plane

Status: accepted

## Context

ADR-0006 bases each building on the scene's one Ground Reference:
`base = terrain(building) − terrain(Dataset Centroid)`. That is correct for
scale, but the map overlay is a single flat sheet at `y = -0.5` covering the
whole view, while ground *downhill* of the Dataset Centroid rebases to a
**negative** base. On the London fixture, 7 of 17 buildings came out at −1 or
−2 m and rendered *underneath* the map sheet — the reported symptom.

The flat sheet is an approximation of sloping ground; the scene has no way to
bend it to the terrain. So some buildings are always going to be above the
sheet's local ground and some below.

## Decision

Clamp every building base to the ground plane: `base = max(0, rebased)`, in
`clampToGroundPlane()` (terrain.js), applied after `rebaseElevations()`.

Ground at or above the reference keeps its full relief, so a hillside still
shows. Ground below the reference is flattened onto the plane, so no building
can punch through the map sheet.

## Why this side of the trade-off

The alternative — leaving negative bases — is faithful to the terrain but
visibly broken: buildings disappear under the map overlay, which reads as a
rendering bug rather than a datum choice. Lifting the whole scene by the
minimum building elevation instead would push every building up and away from
the flat map it is supposed to stand on.

The clamp trades a little vertical truth on the downhill side of every site
for the guarantee that the Building Layer always reads as sitting *on* the
map. That matches the layer's purpose (ADR-0004): a legible visual reference,
not a survey.

## Consequences

- On a site with real relief, buildings at or above the centroid's elevation
  keep their relative heights; those below it all rest together on the plane.
- The clamp is a no-op on flat sites and wherever the reference is the local
  high point, which is the common case.
- An unresolved elevation stays `null`, so the building rests on the plane by
  the same path as the clamp — no separate failure handling.
- This is a scene-presentation rule, not a measurement. No photo-relative
  figure is derived from the clamped value; ADR-0003 still holds.
