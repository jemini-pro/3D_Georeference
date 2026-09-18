# 0002 — Footprints are scaled to true metres; heights are left alone

Status: superseded by [ADR-0005](0005-scene-space-is-true-metres.md)

## Context

Scene Space is Web Mercator metres relative to the Dataset Centroid, so
horizontal distances in it are inflated by `1/cos(latitude)` — 1.60× in
London, 2.00× at Oslo. OSM maps `height` and `building:levels` in **true**
metres. Extruding a Mercator-measured footprint to a true-metre height
therefore produces buildings that are squat and over-wide the further you get
from the equator.

## Decision

In the building path only, scale each footprint's horizontal extent by
`cos(latitude)` before constructing the shape, and leave building heights at
their true-metre values.

## Why this side of the trade-off

The alternative — scaling heights up by `1/cos(latitude)` to match the
inflated frame — is wrong because heights are not the only true-metre quantity
in the scene. Photo altitudes already enter Scene Space as raw metres
(`y: alt`) and the ground tiles are positioned in Mercator metres. Scaling
heights would desynchronise buildings from the photos and the ground they
stand on. Scaling footprints fixes the mismatch against both.

## Consequences

An existing property of the app is left untouched: photo-to-photo horizontal
distances are still Mercator-inflated rather than true metres. This ADR does
not fix that, and the building path must not be read as having fixed it — the
two remain on opposite conventions, deliberately.

Do not "correct" the projection helpers to make these consistent. The
distinction is intentional and documented here precisely so that it is not
mistaken for a bug.
