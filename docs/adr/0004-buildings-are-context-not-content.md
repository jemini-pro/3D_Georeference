# 0004 — Buildings are context: the fetch never blocks and its failures are silent

Status: accepted

## Context

The Building Layer depends on a third-party community API (Overpass) that we
observed failing intermittently against the smallest useful query — one request
answered, the next three returned a dispatcher timeout, then it recovered.
Meanwhile the app's existing contract is that an upload is processed entirely
locally: a ZIP goes in and geometry appears, with no network dependency except
decorative map tiles that already fail gracefully.

Those two facts disagree. Something has to give.

## Decision

The Building Layer is decoration. It is fetched eagerly but never blocks
rendering, it never produces a user-visible error, and it never prevents a
photo from being shown.

Concretely:

- The query fires when the Dataset Centroid is known, and photos render
  immediately without waiting for it.
- Results are cached per rounded bbox for the session, so camera movement and
  re-processing never re-query.
- Failures try the main endpoint, then one mirror, each with a short timeout,
  then stop. No error dialog, no status colour change, log to console only.
- The layer is capped at roughly 1 500 Buildings, nearest to the Dataset
  Centroid first. If the cap bites, the status line says so.
- It is visible by default, behind a toggle alongside the existing map
  overlay toggle.

## Why

The alternative — treating a failed building fetch as an error — elevates
decoration to the status of failure, and would have the app report a problem
on uploads that are in fact complete and correct. An empty building layer
degrades to the current behaviour, which is a flat ground plane, and that is
already an acceptable outcome. The asymmetric costs settle it: a missing
building layer is a slightly less useful scene, whereas a blocked upload or a
spurious error is a broken one.

## Consequences

The OpenStreetMap credit must be persistent and must not be tied to the
Building Layer or map overlay toggles. Both layers are ODbL-derived, so
turning them off cannot remove the attribution — this also closes an existing
gap where switching the map overlay off leaves OSM tiles credited nowhere.

Per-Footprint `ExtrudeGeometry` means one draw call per Building. The cap is
what keeps that acceptable in v1; merging geometry is a v2 optimisation and
the cap should not be mistaken for the final answer.

## Considered alternatives

- **Block the render on the fetch** — breaks the local, instant-upload
  contract for a decorative layer.
- **Show an error on failure** — reports a problem on a successful upload.
- **Default the layer off** — hides the feature and leaves the flat plane as
  the default experience.
