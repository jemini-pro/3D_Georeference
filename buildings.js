// =========================================================================
// GeoMapper 3D — buildings.js
//
// Turns an OpenStreetMap Overpass response into Building shapes the scene
// can extrude. Pure math: no DOM, no Three.js, no network. Loaded as a
// plain <script> in the browser (exposing `Buildings`) and via `require`
// in Node for the test suite.
//
// The Building Layer is context, not content — it exists so photo poses
// read against real structure. See docs/adr/0004.
//
// Footprints arrive as Mercator offsets and are shrunk by the scene frame
// scale (docs/adr/0005), which the caller passes in. See footprintToScene().
// =========================================================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./projection.js'));
    } else {
        root.Buildings = factory(root.Projection);
    }
})(typeof self !== 'undefined' ? self : this, function (Projection) {
    // OSM convention: a storey is assumed to be 3 m when only levels are
    // mapped. Documented on the Simple 3D Buildings wiki page.
    const LEVEL_HEIGHT_M = 3;

    // Used when a building carries neither a height nor a level count. Two
    // storeys: tall enough to read as a structure, short enough that a
    // sparsely-mapped area does not look like a city.
    const DEFAULT_BUILDING_HEIGHT_M = 6;

    // Footprints narrower than this read as rubble at z19. They are usually
    // sheds, garages, and mapping noise.
    const MIN_FOOTPRINT_WIDTH_M = 4;

    /**
     * Parse a leading number from an OSM length value. Handles "12",
     * "12.5", "12 m", "12m". Returns null if there is no usable number.
     * Units other than metres are not converted; OSM defaults to metres.
     */
    function parseLength(value) {
        if (value === null || value === undefined) return null;
        const match = String(value).trim().match(/^-?\d+(\.\d+)?/);
        if (!match) return null;
        const n = parseFloat(match[0]);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * The OSM height ladder: `height`, else `building:levels` x 3 m, else a
     * default. Returns the height in true metres and which rung produced it,
     * so coverage can be reported.
     */
    function resolveBuildingHeight(tags) {
        tags = tags || {};
        const height = parseLength(tags.height);
        if (height !== null && height > 0) {
            return { height, source: 'height' };
        }
        const levels = parseLength(tags['building:levels']);
        if (levels !== null && levels > 0) {
            return { height: levels * LEVEL_HEIGHT_M, source: 'levels' };
        }
        return { height: DEFAULT_BUILDING_HEIGHT_M, source: 'default' };
    }

    /**
     * Extract building outlines from an Overpass `out geom;` response.
     *
     * Returns [{ osmId, tags, outer: [{lat,lon}, ...], holes: [[{lat,lon}...]] }].
     *
     * Handles both forms a building arrives in:
     *  - a `way`, which is a single ring with no holes;
     *  - a multipolygon `relation`, whose members carry `outer` / `inner`
     *    roles — an inner ring is a courtyard and must be hollowed out, not
     *    filled in.
     *
     * A relation with several outer rings (a building split by a road, say)
     * becomes several outlines, each taking only the inner rings it actually
     * contains, so a courtyard is never punched into the wrong building.
     *
     * Rings with fewer than 3 distinct points are dropped.
     */
    function parseOverpassBuildings(json) {
        const elements = (json && json.elements) || [];
        const out = [];
        for (const el of elements) {
            if (el.type === 'way') {
                const ring = cleanRing(el.geometry);
                if (ring.length < 3) continue;
                out.push({ osmId: el.id, tags: el.tags || {}, outer: ring, holes: [] });
            } else if (el.type === 'relation') {
                out.push(...parseBuildingRelation(el));
            }
        }
        return out;
    }

    /**
     * Normalise a raw geometry array to a ring of {lat, lon}: drop unusable
     * points and the repeated closing node Overpass includes.
     */
    function cleanRing(geometry) {
        if (!Array.isArray(geometry)) return [];
        const ring = geometry
            .filter(pt => pt && typeof pt.lat === 'number' && typeof pt.lon === 'number')
            .map(pt => ({ lat: pt.lat, lon: pt.lon }));
        if (ring.length > 1) {
            const first = ring[0], last = ring[ring.length - 1];
            if (first.lat === last.lat && first.lon === last.lon) ring.pop();
        }
        return ring;
    }

    /** Ray-cast point-in-ring, in any 2D space as long as both agree. */
    function pointInRing(point, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].x, yi = ring[i].y;
            const xj = ring[j].x, yj = ring[j].y;
            if (((yi > point.y) !== (yj > point.y)) &&
                (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /** Rough centroid of a ring, adequate for deciding which outer contains it. */
    function ringCentroid(ring) {
        let x = 0, y = 0;
        for (const p of ring) { x += p.x; y += p.y; }
        return { x: x / ring.length, y: y / ring.length };
    }

    /**
     * The lat/lon centroid of a footprint, used as the point whose Terrain
     * Elevation the building sits on. The DEM resolves at ~90 m, so a
     * building-sized footprint is sub-pixel; its centroid is the honest
     * answer and keeps the lookup one point per building.
     */
    function ringCentroidLatLon(ring) {
        let lat = 0, lon = 0;
        for (const p of ring) { lat += p.lat; lon += p.lon; }
        return { lat: lat / ring.length, lon: lon / ring.length };
    }

    function parseBuildingRelation(el) {
        const members = Array.isArray(el.members) ? el.members : [];
        const outers = [];
        const inners = [];
        for (const m of members) {
            const ring = cleanRing(m.geometry);
            if (ring.length < 3) continue;
            if (m.role === 'inner') inners.push(ring);
            else if (m.role === 'outer' || m.role === '') outers.push(ring);
        }
        // An empty `outers` yields no buildings here, which is correct: a
        // relation with only inner rings has no building to draw.

        // Assign each courtyard to the outer ring that contains it, in
        // lat/lon space (containment is projection-independent).
        return outers.map(outer => {
            const asPoints = outer.map(p => ({ x: p.lon, y: p.lat }));
            const holes = inners.filter(inner => {
                const c = ringCentroid(inner.map(p => ({ x: p.lon, y: p.lat })));
                return pointInRing(c, asPoints);
            });
            return { osmId: el.id, tags: el.tags || {}, outer, holes };
        });
    }

    /** Shoelace signed area. Positive is counter-clockwise in y-up space. */
    function signedArea(points) {
        let area = 0;
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            area += a.x * b.y - b.x * a.y;
        }
        return area / 2;
    }

    /**
     * The narrowest span across a footprint, in Scene-space metres. Found by
     * projecting every vertex onto each edge's normal and taking the tightest
     * range. Rotation-invariant, unlike an axis-aligned bounding box, which
     * would let a long thin diagonal footprint slip past the rubble filter.
     */
    function minWidth(points) {
        let narrowest = Infinity;
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const ex = b.x - a.x, ey = b.y - a.y;
            const len = Math.hypot(ex, ey);
            if (len < 1e-9) continue;
            const nx = -ey / len, ny = ex / len;
            let lo = Infinity, hi = -Infinity;
            for (const p of points) {
                const d = p.x * nx + p.y * ny;
                if (d < lo) lo = d;
                if (d > hi) hi = d;
            }
            if (hi - lo < narrowest) narrowest = hi - lo;
        }
        return narrowest === Infinity ? 0 : narrowest;
    }

    /** Force a ring to counter-clockwise winding, without mutating it. */
    function ensureCCW(points) {
        return signedArea(points) < 0 ? points.slice().reverse() : points.slice();
    }

    /** Force a ring to clockwise winding, without mutating it. */
    function ensureCW(points) {
        return signedArea(points) > 0 ? points.slice().reverse() : points.slice();
    }

    /**
     * A footprint ring (lat/lon) -> a ring in shape space: local 2D
     * coordinates for THREE.Shape, in true metres, centred on the footprint.
     *
     * The scene frame is scaled as a whole by the caller (docs/adr/0005):
     * position and extent both start as Web Mercator offsets about the
     * Dataset Centroid, then `horizontalScale` shrinks every offset about
     * the origin — so the building sits exactly where the scaled map tiles
     * and photo positions put it. Altitudes and heights are not scaled.
     *
     * Shape-space y is negated Scene-Space z, because the mesh is rotated
     * -PI/2 about X to turn ExtrudeGeometry's +Z extrusion into scene up.
     */
    function footprintToScene(ring, centerMercator, horizontalScale) {
        const scene = ring.map(pt => {
            const pos = Projection.gpsToCartesian(pt.lat, pt.lon, 0, centerMercator, horizontalScale);
            return { x: pos.x, z: pos.z };
        });

        return scene.map(p => ({ x: p.x, y: -p.z }));
    }

    /**
     * Full pipeline: Overpass JSON -> extrudable Buildings, ready for the
     * scene. Rings that are too narrow are dropped. Outer rings are wound
     * counter-clockwise for THREE.Shape and holes clockwise, because a hole
     * wound the same way as its outer ring renders filled in.
     *
     * `horizontalScale` is the ADR-0005 frame scale (cos of the centroid
     * latitude); pass 1 for pure Mercator offsets. The rubble filter runs in
     * the scaled frame, so its 4 m threshold is true metres either way.
     */
    function buildBuildingShapes(json, centerMercator, horizontalScale) {
        const out = [];
        for (const parsed of parseOverpassBuildings(json)) {
            const outer = footprintToScene(parsed.outer, centerMercator, horizontalScale);
            if (outer.length < 3) continue;
            if (minWidth(outer) < MIN_FOOTPRINT_WIDTH_M) continue;

            const holes = parsed.holes
                .map(hole => footprintToScene(hole, centerMercator, horizontalScale))
                .filter(hole => hole.length >= 3 && minWidth(hole) >= MIN_FOOTPRINT_WIDTH_M);

            const { height, source } = resolveBuildingHeight(parsed.tags);
            const centroid = ringCentroidLatLon(parsed.outer);
            out.push({
                osmId: parsed.osmId,
                height,
                heightSource: source,
                lat: centroid.lat,
                lon: centroid.lon,
                outer: ensureCCW(outer),
                holes: holes.map(ensureCW),
            });
        }
        return out;
    }

    return {
        LEVEL_HEIGHT_M,
        DEFAULT_BUILDING_HEIGHT_M,
        MIN_FOOTPRINT_WIDTH_M,
        parseLength,
        resolveBuildingHeight,
        parseOverpassBuildings,
        signedArea,
        minWidth,
        ensureCCW,
        ensureCW,
        pointInRing,
        ringCentroidLatLon,
        footprintToScene,
        buildBuildingShapes,
    };
});
