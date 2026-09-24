// =========================================================================
// Tests for buildings.js — Overpass parsing, the height ladder, footprint
// filtering, winding, and the Scene-Space footprint transform.
//
//   node --test
//
// Numbers marked "independent" are computed from the published Mercator
// formula and cosine factors in the test itself or hard-coded from that
// derivation, not read out of the module under test.
// =========================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('./buildings.js');
const P = require('./projection.js');

const closeTo = (actual, expected, tolerance, msg) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        msg || `expected ${actual} to be within ${tolerance} of ${expected}`
    );
};

const squareRing = (lat, lon, d) => ([
    { lat, lon },
    { lat, lon: lon + d },
    { lat: lat + d, lon: lon + d },
    { lat: lat + d, lon },
]);

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------
test('the OSM storey height convention is 3 m', () => {
    assert.equal(B.LEVEL_HEIGHT_M, 3);
});

test('the default building height is the documented 6 m', () => {
    assert.equal(B.DEFAULT_BUILDING_HEIGHT_M, 6);
});

// -------------------------------------------------------------------------
// parseLength
// -------------------------------------------------------------------------
test('parseLength reads plain numbers', () => {
    assert.equal(B.parseLength('12'), 12);
    assert.equal(B.parseLength('12.5'), 12.5);
    assert.equal(B.parseLength(12), 12);
    assert.equal(B.parseLength(12.5), 12.5);
});

test('parseLength tolerates a trailing unit and whitespace', () => {
    assert.equal(B.parseLength('12 m'), 12);
    assert.equal(B.parseLength('12m'), 12);
    assert.equal(B.parseLength('  24  '), 24);
});

test('parseLength returns null for unusable input', () => {
    assert.equal(B.parseLength(null), null);
    assert.equal(B.parseLength(undefined), null);
    assert.equal(B.parseLength(''), null);
    assert.equal(B.parseLength('abc'), null);
    assert.equal(B.parseLength('m'), null);
    assert.equal(B.parseLength({}), null);
    assert.equal(B.parseLength(NaN), null);
});

test('parseLength keeps zero and negatives rather than coercing them', () => {
    // Validity is the height ladder's business, not the parser's.
    assert.equal(B.parseLength('0'), 0);
    assert.equal(B.parseLength('-3'), -3);
});

// -------------------------------------------------------------------------
// resolveBuildingHeight — the OSM ladder
// -------------------------------------------------------------------------
test('resolveBuildingHeight prefers height over building:levels', () => {
    assert.deepEqual(
        B.resolveBuildingHeight({ height: '24', 'building:levels': '8' }),
        { height: 24, source: 'height' }
    );
});

test('resolveBuildingHeight falls back to levels x 3 m', () => {
    assert.deepEqual(
        B.resolveBuildingHeight({ 'building:levels': '5' }),
        { height: 15, source: 'levels' }
    );
});

test('resolveBuildingHeight falls back to the default with no data', () => {
    assert.deepEqual(B.resolveBuildingHeight({}), { height: 6, source: 'default' });
    assert.deepEqual(B.resolveBuildingHeight(undefined), { height: 6, source: 'default' });
});

test('resolveBuildingHeight treats height=0 as absent', () => {
    // A zero-height building is not a building; fall through to levels.
    assert.deepEqual(
        B.resolveBuildingHeight({ height: '0', 'building:levels': '3' }),
        { height: 9, source: 'levels' }
    );
});

test('resolveBuildingHeight ignores unparseable values at every rung', () => {
    assert.deepEqual(
        B.resolveBuildingHeight({ height: 'tall', 'building:levels': 'many' }),
        { height: 6, source: 'default' }
    );
});

test('the ladder never returns a non-positive height', () => {
    const cases = [
        {}, { height: '0' }, { height: '-5' }, { 'building:levels': '0' },
        { 'building:levels': '-2' }, { height: 'bad', 'building:levels': 'bad' },
    ];
    cases.forEach(tags => {
        assert.ok(B.resolveBuildingHeight(tags).height > 0, `height for ${JSON.stringify(tags)}`);
    });
});

// -------------------------------------------------------------------------
// parseOverpassBuildings
// -------------------------------------------------------------------------
test('parseOverpassBuildings extracts ways with their geometry and tags', () => {
    const json = {
        elements: [{
            type: 'way', id: 42,
            tags: { building: 'yes', 'building:levels': '4' },
            geometry: squareRing(51.5, -0.12, 0.001),
        }],
    };
    const out = B.parseOverpassBuildings(json);
    assert.equal(out.length, 1);
    assert.equal(out[0].osmId, 42);
    assert.equal(out[0].tags['building:levels'], '4');
    assert.equal(out[0].outer.length, 4);
    assert.deepEqual(out[0].holes, []);
});

test('parseOverpassBuildings drops the repeated closing node', () => {
    const closed = squareRing(51.5, -0.12, 0.001);
    closed.push({ ...closed[0] });
    const json = { elements: [{ type: 'way', id: 1, tags: {}, geometry: closed }] };
    assert.equal(B.parseOverpassBuildings(json)[0].outer.length, 4, 'should not keep 5 points');
});

test('parseOverpassBuildings ignores node elements', () => {
    const json = {
        elements: [
            { type: 'node', id: 1, lat: 51.5, lon: -0.12 },
            { type: 'way', id: 3, tags: {}, geometry: squareRing(51.5, -0.12, 0.001) },
        ],
    };
    const out = B.parseOverpassBuildings(json);
    assert.equal(out.length, 1);
    assert.equal(out[0].osmId, 3);
});

test('parseOverpassBuildings drops rings with fewer than 3 points', () => {
    const json = {
        elements: [
            { type: 'way', id: 1, tags: {}, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
            { type: 'way', id: 2, tags: {}, geometry: [{ lat: 1, lon: 1 }] },
        ],
    };
    assert.equal(B.parseOverpassBuildings(json).length, 0);
});

test('parseOverpassBuildings survives malformed input without throwing', () => {
    assert.deepEqual(B.parseOverpassBuildings(null), []);
    assert.deepEqual(B.parseOverpassBuildings({}), []);
    assert.deepEqual(B.parseOverpassBuildings({ elements: 'nope' }), []);
    assert.deepEqual(
        B.parseOverpassBuildings({ elements: [{ type: 'way', id: 1, geometry: 'bad' }] }),
        []
    );
});

test('parseOverpassBuildings filters out non-numeric coordinates', () => {
    const json = {
        elements: [{
            type: 'way', id: 1, tags: {},
            geometry: [
                { lat: 51.5, lon: -0.12 },
                { lat: null, lon: -0.12 },
                { lat: 51.5, lon: 'x' },
                { lat: 51.501, lon: -0.12 },
                { lat: 51.501, lon: -0.119 },
            ],
        }],
    };
    assert.equal(B.parseOverpassBuildings(json)[0].outer.length, 3);
});

// -------------------------------------------------------------------------
// parseOverpassBuildings — multipolygon relations (courtyard buildings)
// -------------------------------------------------------------------------
const relationWithCourtyard = () => ({
    type: 'relation', id: 2071332,
    tags: { building: 'yes', 'building:levels': '4' },
    members: [
        {
            type: 'way', ref: 1, role: 'outer',
            geometry: [
                { lat: 51.50, lon: -0.13 }, { lat: 51.50, lon: -0.12 },
                { lat: 51.51, lon: -0.12 }, { lat: 51.51, lon: -0.13 },
            ],
        },
        {
            type: 'way', ref: 2, role: 'inner',
            geometry: [
                { lat: 51.504, lon: -0.126 }, { lat: 51.504, lon: -0.124 },
                { lat: 51.506, lon: -0.124 }, { lat: 51.506, lon: -0.126 },
            ],
        },
    ],
});

test('parseOverpassBuildings reads an outer ring and its courtyard from a relation', () => {
    const out = B.parseOverpassBuildings({ elements: [relationWithCourtyard()] });
    assert.equal(out.length, 1);
    assert.equal(out[0].osmId, 2071332);
    assert.equal(out[0].outer.length, 4);
    assert.equal(out[0].holes.length, 1, 'the inner ring must become a hole');
    assert.equal(out[0].holes[0].length, 4);
});

test('parseOverpassBuildings keeps a relation with no inner ring hole-free', () => {
    const rel = relationWithCourtyard();
    rel.members = rel.members.filter(m => m.role !== 'inner');
    const out = B.parseOverpassBuildings({ elements: [rel] });
    assert.equal(out[0].holes.length, 0);
});

test('parseOverpassBuildings ignores a relation with no outer ring', () => {
    const rel = relationWithCourtyard();
    rel.members = rel.members.filter(m => m.role !== 'outer');
    assert.deepEqual(B.parseOverpassBuildings({ elements: [rel] }), []);
});

test('parseOverpassBuildings gives each outer ring only the holes it contains', () => {
    // Two disjoint buildings in one relation; only the first has a courtyard.
    const rel = {
        type: 'relation', id: 5, tags: { building: 'yes' },
        members: [
            {
                type: 'way', ref: 1, role: 'outer',
                geometry: [
                    { lat: 51.50, lon: -0.13 }, { lat: 51.50, lon: -0.12 },
                    { lat: 51.51, lon: -0.12 }, { lat: 51.51, lon: -0.13 },
                ],
            },
            {
                type: 'way', ref: 2, role: 'outer',
                geometry: [
                    { lat: 52.00, lon: -0.13 }, { lat: 52.00, lon: -0.12 },
                    { lat: 52.01, lon: -0.12 }, { lat: 52.01, lon: -0.13 },
                ],
            },
            {
                type: 'way', ref: 3, role: 'inner',
                geometry: [
                    { lat: 51.504, lon: -0.126 }, { lat: 51.504, lon: -0.124 },
                    { lat: 51.506, lon: -0.124 }, { lat: 51.506, lon: -0.126 },
                ],
            },
        ],
    };
    const out = B.parseOverpassBuildings({ elements: [rel] });
    assert.equal(out.length, 2, 'two outer rings -> two buildings');
    assert.equal(out.find(b => b.outer[0].lat < 51.6).holes.length, 1, 'first has the courtyard');
    assert.equal(out.find(b => b.outer[0].lat > 51.6).holes.length, 0, 'second must not be punched');
});

test('pointInRing detects containment and rejection', () => {
    const square = [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ];
    assert.equal(B.pointInRing({ x: 5, y: 5 }, square), true);
    assert.equal(B.pointInRing({ x: 15, y: 5 }, square), false);
});

// -------------------------------------------------------------------------
// signedArea / winding
// -------------------------------------------------------------------------
test('signedArea is positive counter-clockwise and negative clockwise', () => {
    const ccw = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const cw = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
    assert.equal(B.signedArea(ccw), 1);
    assert.equal(B.signedArea(cw), -1);
});

test('signedArea is orientation-independent in magnitude', () => {
    const ccw = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }];
    const cw = ccw.slice().reverse();
    assert.equal(B.signedArea(ccw), -B.signedArea(cw));
});

test('ensureCCW makes a clockwise ring counter-clockwise', () => {
    const cw = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
    assert.ok(B.signedArea(B.ensureCCW(cw)) > 0);
});

test('ensureCCW leaves an already-counter-clockwise ring alone', () => {
    const ccw = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    assert.deepEqual(B.ensureCCW(ccw), ccw);
});

test('ensureCW is the opposite of ensureCCW', () => {
    const ccw = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    assert.ok(B.signedArea(B.ensureCW(ccw)) < 0);
    assert.deepEqual(B.ensureCW(ccw), ccw.slice().reverse());
});

test('the winding helpers never mutate their input', () => {
    const cw = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
    const snapshot = JSON.parse(JSON.stringify(cw));
    B.ensureCCW(cw);
    B.ensureCW(cw);
    assert.deepEqual(cw, snapshot);
});

// -------------------------------------------------------------------------
// minWidth — the rubble filter's metric
// -------------------------------------------------------------------------
test('minWidth measures the narrow side of a rectangle', () => {
    closeTo(B.minWidth([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 100 }, { x: 0, y: 100 }]), 3, 1e-9);
});

test('minWidth is rotation-invariant, unlike a bounding box', () => {
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 100 }, { x: 0, y: 100 }];
    const th = Math.PI / 4;
    const rotated = pts.map(p => ({
        x: p.x * Math.cos(th) - p.y * Math.sin(th),
        y: p.x * Math.sin(th) + p.y * Math.cos(th),
    }));
    closeTo(B.minWidth(rotated), 3, 1e-6);
    // A bbox-based filter would see ~73 m of extent and wrongly keep it.
    const bboxHeight = Math.max(...rotated.map(p => p.y)) - Math.min(...rotated.map(p => p.y));
    assert.ok(bboxHeight > 70, 'the bounding box really is misleading here');
});

test('minWidth of a square is its side', () => {
    closeTo(B.minWidth([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }]), 5, 1e-9);
});

test('minWidth returns 0 rather than infinities for a degenerate ring', () => {
    assert.equal(B.minWidth([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }]), 0);
});

// -------------------------------------------------------------------------
// footprintToScene — the ADR-0005 frame-scale transform
// -------------------------------------------------------------------------
test('footprintToScene leaves Mercator offsets untouched by default', () => {
    // With no frame scale the footprint is pure Mercator offsets: the
    // scene's frame is scaled as a whole by the caller, not here (ADR-0005).
    const center = P.latLonToMercator(51.5, -0.12);
    const ring = squareRing(51.5, -0.12, 0.001).map(p => ({ lat: p.lat, lon: p.lon }));
    const out = B.footprintToScene(ring, center);

    const w = Math.max(...out.map(p => p.x)) - Math.min(...out.map(p => p.x));
    const h = Math.max(...out.map(p => p.y)) - Math.min(...out.map(p => p.y));

    // The raw Mercator extent, with no shrink applied.
    const rawW = P.latLonToMercator(51.5, -0.119).x - P.latLonToMercator(51.5, -0.12).x;
    const rawH = Math.abs(P.latLonToMercator(51.501, -0.12).y - P.latLonToMercator(51.5, -0.12).y);
    closeTo(w, rawW, 1e-6);
    closeTo(h, rawH, 1e-6);
});

test('footprintToScene scales offsets about the origin by the frame scale', () => {
    // The scene frame shrinks by cos(latitude) as a whole, so a footprint's
    // every offset from the origin scales with it — and the extent lands on
    // true metres, matching the tiles and photos around it (ADR-0005).
    const center = P.latLonToMercator(51.5, -0.12);
    const ring = squareRing(51.5, -0.12, 0.001).map(p => ({ lat: p.lat, lon: p.lon }));
    const out = B.footprintToScene(ring, center, 0.6225146366376195);

    const w = Math.max(...out.map(p => p.x)) - Math.min(...out.map(p => p.x));
    const h = Math.max(...out.map(p => p.y)) - Math.min(...out.map(p => p.y));

    // The raw Mercator extent, shrunk by cos(51.5 deg).
    const rawW = P.latLonToMercator(51.5, -0.119).x - P.latLonToMercator(51.5, -0.12).x;
    const rawH = Math.abs(P.latLonToMercator(51.501, -0.12).y - P.latLonToMercator(51.5, -0.12).y);
    const s = 0.6225146366376195;

    closeTo(w, rawW * s, 1e-6);
    closeTo(h, rawH * s, 1e-6);
});

test('footprintToScene scales about the origin, not the footprint centre', () => {
    // The frame scale moves a footprint's centre toward the origin — that is
    // what "the frame is scaled" means — so a footprint far from the centroid
    // is drawn exactly where the scaled tiles and photos put it. Scaling about
    // the footprint's own centre would detach it from the map underneath.
    const center = P.latLonToMercator(60, 1.0);
    const ring = [
        { lat: 60.0000, lon: 1.0010 },
        { lat: 60.0000, lon: 1.0020 },
        { lat: 60.0010, lon: 1.0020 },
        { lat: 60.0010, lon: 1.0010 },
    ];
    const unscaled = B.footprintToScene(ring, center, 1);
    const scaled = B.footprintToScene(ring, center, 0.5);

    const centre = pts => ({
        x: (Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.x))) / 2,
        y: (Math.min(...pts.map(p => p.y)) + Math.max(...pts.map(p => p.y))) / 2,
    });
    const uc = centre(unscaled);
    const sc = centre(scaled);
    closeTo(sc.x, uc.x * 0.5, 1e-6, 'centre must scale toward the origin');
    closeTo(sc.y, uc.y * 0.5, 1e-6);
});

test('footprintToScene leaves a centroid-centred footprint centred on the origin', () => {
    // A ring straddling the centroid has zero offset, so the frame scale
    // cannot move it.
    const center = P.latLonToMercator(30, 0);
    const d = 0.001;
    const ring = [
        { lat: 30 - d, lon: -d },
        { lat: 30 - d, lon: d },
        { lat: 30 + d, lon: d },
        { lat: 30 + d, lon: -d },
    ];
    const out = B.footprintToScene(ring, center, 0.5);
    const cx = (Math.min(...out.map(p => p.x)) + Math.max(...out.map(p => p.x))) / 2;
    const cy = (Math.min(...out.map(p => p.y)) + Math.max(...out.map(p => p.y))) / 2;
    closeTo(cx, 0, 1e-3);
    closeTo(cy, 0, 1e-3);
});

test('footprintToScene negates z, matching the scene Y-up convention', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const ring = squareRing(51.5, -0.12, 0.001);
    const out = B.footprintToScene(ring, center);
    // Points north of the centroid must have negative Scene z, hence
    // positive shape y (because shape y = -(scene z)).
    const northPts = out.filter((p, i) => ring[i].lat > 51.5005);
    assert.ok(northPts.length > 0, 'test needs points north of centre');
    northPts.forEach(p => assert.ok(p.y > 0, 'north should be +shape y'));
});

test('footprintToScene does not distort the footprint shape', () => {
    // A square stays a square: uniform scaling must not stretch one axis.
    const center = P.latLonToMercator(0, 0);
    const d = 0.001;
    const ring = [
        { lat: -d, lon: -d }, { lat: -d, lon: d },
        { lat: d, lon: d }, { lat: d, lon: -d },
    ];
    const out = B.footprintToScene(ring, center, 0.6225146366376195);
    const w = Math.max(...out.map(p => p.x)) - Math.min(...out.map(p => p.x));
    const h = Math.max(...out.map(p => p.y)) - Math.min(...out.map(p => p.y));
    closeTo(w, h, 1e-6);
});

// -------------------------------------------------------------------------
// buildBuildingShapes — the whole pipeline
// -------------------------------------------------------------------------
test('buildBuildingShapes produces one shape per usable footprint', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const json = {
        elements: [{
            type: 'way', id: 7, tags: { building: 'yes', 'building:levels': '4' },
            geometry: squareRing(51.5, -0.12, 0.001),
        }],
    };
    const out = B.buildBuildingShapes(json, center, 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].height, 12);
    assert.equal(out[0].heightSource, 'levels');
    assert.equal(out[0].outer.length, 4);
    assert.deepEqual(out[0].holes, []);
});

test('buildBuildingShapes drops footprints narrower than the threshold', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    // ~2 m wide, ~40 m long: a garden wall or shed.
    const json = {
        elements: [{
            type: 'way', id: 8, tags: {},
            geometry: squareRing(51.5, -0.12, 0.00002),
        }],
    };
    assert.equal(B.buildBuildingShapes(json, center, 1).length, 0);
});

test('buildBuildingShapes keeps a building comfortably above the threshold', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const json = {
        elements: [{
            type: 'way', id: 9, tags: {},
            geometry: squareRing(51.5, -0.12, 0.0002), // ~14 m
        }],
    };
    assert.equal(B.buildBuildingShapes(json, center, 1).length, 1);
});

test('buildBuildingShapes winds outer rings counter-clockwise', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const cw = squareRing(51.5, -0.12, 0.001).reverse();
    const json = { elements: [{ type: 'way', id: 10, tags: {}, geometry: cw }] };
    const out = B.buildBuildingShapes(json, center, 1);
    assert.ok(B.signedArea(out[0].outer) > 0, 'outer ring must be CCW');
});

test('buildBuildingShapes winds a courtyard opposite to its outer ring', () => {
    // Same winding direction as the outer ring must be flipped, or
    // THREE.Shape fills the courtyard in.
    const center = P.latLonToMercator(51.5, -0.12);
    const rel = relationWithCourtyard();
    // Make the inner ring and the outer ring the same orientation.
    rel.members[1].geometry = rel.members[1].geometry.slice();
    const out = B.buildBuildingShapes({ elements: [rel] }, center, 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].holes.length, 1);
    assert.ok(B.signedArea(out[0].outer) > 0, 'outer must be CCW');
    assert.ok(B.signedArea(out[0].holes[0]) < 0, 'hole must be CW');
});

test('buildBuildingShapes drops a courtyard too small to be real', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const rel = relationWithCourtyard();
    // ~1.4 m x 2.2 m at this latitude: a light well, or noise. Below the
    // 4 m threshold.
    rel.members[1].geometry = [
        { lat: 51.50490, lon: -0.12500 }, { lat: 51.50490, lon: -0.12498 },
        { lat: 51.50492, lon: -0.12498 }, { lat: 51.50492, lon: -0.12500 },
    ];
    const out = B.buildBuildingShapes({ elements: [rel] }, center, 1);
    assert.equal(out[0].holes.length, 0, 'degenerate hole should be dropped');
});

test('buildBuildingShapes carries the footprint centroid for terrain lookup', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const json = {
        elements: [{
            type: 'way', id: 14, tags: {},
            geometry: squareRing(51.5, -0.12, 0.001),
        }],
    };
    const out = B.buildBuildingShapes(json, center, 1);
    assert.equal(out.length, 1);
    closeTo(out[0].lat, 51.5005, 0.001, 'centroid latitude of the ring');
    closeTo(out[0].lon, -0.1195, 0.001, 'centroid longitude of the ring');
});

test('buildBuildingShapes gives every building a positive height', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const json = {
        elements: [
            { type: 'way', id: 11, tags: {}, geometry: squareRing(51.5, -0.12, 0.001) },
            { type: 'way', id: 12, tags: { height: '0' }, geometry: squareRing(51.502, -0.122, 0.001) },
            { type: 'way', id: 13, tags: { height: 'junk' }, geometry: squareRing(51.504, -0.124, 0.001) },
        ],
    };
    const out = B.buildBuildingShapes(json, center, 1);
    assert.equal(out.length, 3);
    out.forEach(b => assert.ok(b.height > 0, `building ${b.osmId} height ${b.height}`));
});

test('buildBuildingShapes returns [] for an empty or malformed response', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    assert.deepEqual(B.buildBuildingShapes({ elements: [] }, center, 1), []);
    assert.deepEqual(B.buildBuildingShapes(null, center, 1), []);
    assert.deepEqual(B.buildBuildingShapes({ elements: 'bad' }, center, 1), []);
});

test('buildBuildingShapes handles a realistic multi-building response', () => {
    const center = P.latLonToMercator(51.5, -0.12);
    const elements = [];
    for (let i = 0; i < 20; i++) {
        elements.push({
            type: 'way', id: 100 + i,
            tags: i % 3 === 0 ? { height: '18' } : i % 3 === 1 ? { 'building:levels': '2' } : {},
            geometry: squareRing(51.5 + i * 0.0001, -0.12 + i * 0.0001, 0.0002),
        });
    }
    const out = B.buildBuildingShapes({ elements }, center, 1);
    assert.equal(out.length, 20);
    const sources = out.map(b => b.heightSource);
    assert.ok(sources.includes('height'));
    assert.ok(sources.includes('levels'));
    assert.ok(sources.includes('default'));
});

// -------------------------------------------------------------------------
// Module loading
// -------------------------------------------------------------------------
test('the module exports the documented surface', () => {
    const expected = [
        'LEVEL_HEIGHT_M', 'DEFAULT_BUILDING_HEIGHT_M', 'MIN_FOOTPRINT_WIDTH_M',
        'parseLength', 'resolveBuildingHeight', 'parseOverpassBuildings',
        'signedArea', 'minWidth', 'ensureCCW', 'ensureCW',
        'pointInRing', 'ringCentroidLatLon', 'footprintToScene', 'buildBuildingShapes',
    ];
    expected.forEach(key => assert.ok(key in B, `expected buildings.js to export ${key}`));
});

test('the module loads with no DOM or Three.js present', () => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof globalThis.THREE, 'undefined');
    assert.equal(typeof B.buildBuildingShapes, 'function');
});
