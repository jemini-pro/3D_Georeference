// =========================================================================
// Tests for projection.js — pure coordinate math, no browser required.
//
//   node --test
//
// Reference values marked "EPSG:3857" are the published projection of the
// named coordinate, not a re-run of this module's own formula, so these
// tests would catch a formula that is self-consistently wrong.
// =========================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./projection.js');

const closeTo = (actual, expected, tolerance, msg) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        msg || `expected ${actual} to be within ${tolerance} of ${expected}`
    );
};

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------
test('R is the WGS84 equatorial radius', () => {
    assert.equal(P.R, 6378137);
});

test('MAX_MERCATOR_LAT is the standard Web Mercator limit', () => {
    closeTo(P.MAX_MERCATOR_LAT, 85.05112878, 1e-8);
});

test('degToRad matches Math.PI-based conversion', () => {
    closeTo(P.degToRad(180), Math.PI, 1e-12);
    closeTo(P.degToRad(90), Math.PI / 2, 1e-12);
    assert.equal(P.degToRad(0), 0);
});

// -------------------------------------------------------------------------
// latLonToMercator
// -------------------------------------------------------------------------
test('latLonToMercator projects the equator/prime-meridian to the origin', () => {
    const m = P.latLonToMercator(0, 0);
    closeTo(m.x, 0, 1e-9);
    closeTo(m.y, 0, 1e-6);
});

test('latLonToMercator matches EPSG:3857 for lon=2, lat=49', () => {
    const m = P.latLonToMercator(49, 2);
    closeTo(m.x, 222638.98, 0.01);
    closeTo(m.y, 6274861.39, 0.01);
});

test('latLonToMercator puts lon=180 at half the world width', () => {
    const m = P.latLonToMercator(0, 180);
    closeTo(m.x, Math.PI * P.R, 1e-6);
});

test('latLonToMercator sign conventions: east is +x, north is +y', () => {
    const east = P.latLonToMercator(0, 10);
    const west = P.latLonToMercator(0, -10);
    const north = P.latLonToMercator(10, 0);
    const south = P.latLonToMercator(-10, 0);
    assert.ok(east.x > 0, 'east should be +x');
    assert.ok(west.x < 0, 'west should be -x');
    assert.ok(north.y > 0, 'north should be +y');
    assert.ok(south.y < 0, 'south should be -y');
});

test('latLonToMercator clamps latitudes beyond the Mercator limit', () => {
    assert.deepEqual(P.latLonToMercator(89, 0), P.latLonToMercator(P.MAX_MERCATOR_LAT, 0));
    assert.deepEqual(P.latLonToMercator(-89, 0), P.latLonToMercator(-P.MAX_MERCATOR_LAT, 0));
});

test('latLonToMercator stays finite at the poles', () => {
    [90, -90, 89.9, -89.9].forEach(lat => {
        const m = P.latLonToMercator(lat, 0);
        assert.ok(Number.isFinite(m.y), `y for lat=${lat} should be finite`);
    });
});

// -------------------------------------------------------------------------
// gpsToCartesian
// -------------------------------------------------------------------------
test('gpsToCartesian puts the centre itself at the origin', () => {
    const center = P.latLonToMercator(51.5007, -0.1246);
    const pos = P.gpsToCartesian(51.5007, -0.1246, 0, center);
    closeTo(pos.x, 0, 1e-6);
    closeTo(pos.z, 0, 1e-6);
});

test('gpsToCartesian maps altitude straight to y', () => {
    const center = P.latLonToMercator(51.5007, -0.1246);
    assert.equal(P.gpsToCartesian(51.5007, -0.1246, 123.4, center).y, 123.4);
    assert.equal(P.gpsToCartesian(51.5007, -0.1246, 0, center).y, 0);
    assert.equal(P.gpsToCartesian(51.5007, -0.1246, -12, center).y, -12);
});

test('gpsToCartesian: north of centre is -z, east of centre is +x', () => {
    const center = P.latLonToMercator(51.5007, -0.1246);
    const north = P.gpsToCartesian(51.501, -0.1246, 0, center);
    const east = P.gpsToCartesian(51.5007, -0.124, 0, center);
    assert.ok(north.z < 0, 'north should be -z so the scene is Y-up right-handed');
    assert.ok(east.x > 0, 'east should be +x');
});

test('gpsToCartesian wraps points across the antimeridian to stay close', () => {
    // 179.9E and 179.9W are 0.2 degrees apart; naively they are a world apart.
    const center = P.latLonToMercator(0, 179.9);
    const across = P.gpsToCartesian(0, -179.9, 0, center);
    const expected = 40075016.68557849 * 0.2 / 360; // 0.2 deg at the equator
    closeTo(across.x, expected, 0.01);
    assert.ok(Math.abs(across.x) < 25000, 'should not be half a world away');
});

test('gpsToCartesian leaves ordinary nearby points unwrapped', () => {
    const center = P.latLonToMercator(51.5007, -0.1246);
    const near = P.gpsToCartesian(51.5007, -0.124, 0, center);
    assert.ok(near.x > 0 && near.x < 100, 'a nearby point should be metres away, not wrapped');
});

test('gpsToCartesian is relative: shifting the centre shifts the result', () => {
    const a = P.latLonToMercator(51.5007, -0.1246);
    const b = P.latLonToMercator(51.5007, -0.0);
    const fromA = P.gpsToCartesian(51.5010, -0.1240, 0, a);
    const fromB = P.gpsToCartesian(51.5010, -0.1240, 0, b);
    assert.notEqual(fromA.x.toFixed(3), fromB.x.toFixed(3));
});

// -------------------------------------------------------------------------
// getDatasetCentroid
// -------------------------------------------------------------------------
test('getDatasetCentroid returns the mid-point of the bounding box', () => {
    const c = P.getDatasetCentroid([
        { lat: 10, lng: 20 },
        { lat: 20, lng: 40 },
    ]);
    assert.deepEqual(c, { lat: 15, lng: 30 });
});

test('getDatasetCentroid handles a single point', () => {
    assert.deepEqual(P.getDatasetCentroid([{ lat: 5, lng: 7 }]), { lat: 5, lng: 7 });
});

test('getDatasetCentroid handles negative and mixed-hemisphere coordinates', () => {
    const c = P.getDatasetCentroid([
        { lat: -10, lng: -20 },
        { lat: 10, lng: 20 },
    ]);
    assert.deepEqual(c, { lat: 0, lng: 0 });
});

// -------------------------------------------------------------------------
// Tile math
// -------------------------------------------------------------------------
test('long2tile/lat2tile put the world origin in tile 0 at zoom 0', () => {
    assert.equal(P.long2tile(0, 0), 0);
    assert.equal(P.lat2tile(0, 0), 0);
});

test('long2tile/lat2tile match known slippy-map indices at zoom 19', () => {
    assert.equal(P.long2tile(-0.1246, 19), 261962);
    assert.equal(P.lat2tile(51.5007, 19), 174354);
});

test('long2tile increases eastward and lat2tile increases southward', () => {
    // Zoom 19 is fine enough to separate points a few degrees apart; at
    // zoom 5 they can land in the same tile.
    assert.ok(P.long2tile(10, 19) > P.long2tile(0, 19));
    assert.ok(P.lat2tile(-10, 19) > P.lat2tile(10, 19));
});

test('tileSizeMeters halves as zoom increases', () => {
    // Independent values: world circumference (EPSG:3857 extent), and the
    // z1 / z19 tile edges in metres.
    assert.equal(P.tileSizeMeters(0), 40075016.68557849);
    closeTo(P.tileSizeMeters(1), 20037508.342789244, 1e-6);
    closeTo(P.tileSizeMeters(19), 76.43702828517625, 1e-9);
});

test('tileMercatorCenter lies inside its own tile', () => {
    const zoom = 19;
    const x = P.long2tile(-0.1246, zoom);
    const y = P.lat2tile(51.5007, zoom);
    const center = P.tileMercatorCenter(x, y, zoom);
    const size = 76.43702828517625; // z19 tile edge in metres

    // Independent tile corners from the slippy-map definition, not from the
    // function under test: the tile's west edge and north edge in metres.
    const tileLeft = (x / 2 ** zoom) * 40075016.68557849 - 20037508.342789244;
    const tileTop = 20037508.342789244 - (y / 2 ** zoom) * 40075016.68557849;

    assert.ok(center.x > tileLeft && center.x < tileLeft + size, 'center.x inside tile');
    assert.ok(center.y < tileTop && center.y > tileTop - size, 'center.y inside tile');
});

test('tileMercatorCenter of tile 0,0 at zoom 1 is the north-west quadrant centre', () => {
    // At zoom 1 tile (0,0) is the NW quadrant: its centre is a quarter of
    // the world west and a quarter north of the origin.
    const c = P.tileMercatorCenter(0, 0, 1);
    closeTo(c.x, -10018754.171394622, 1e-6);
    closeTo(c.y, 10018754.171394622, 1e-6);
});

// -------------------------------------------------------------------------
// trueMetresPerMercatorMetre — the ADR-0002 scale factor
// -------------------------------------------------------------------------
test('trueMetresPerMercatorMetre is 1 at the equator', () => {
    closeTo(P.trueMetresPerMercatorMetre(0), 1, 1e-12);
});

test('trueMetresPerMercatorMetre matches cos(latitude) at known latitudes', () => {
    // Published cosines, not a re-evaluation of the module's own expression.
    closeTo(P.trueMetresPerMercatorMetre(60), 0.5, 1e-12);
    closeTo(P.trueMetresPerMercatorMetre(51.5), 0.6225146366376195, 1e-15);
    closeTo(P.trueMetresPerMercatorMetre(-51.5), 0.6225146366376195, 1e-15);
});

test('trueMetresPerMercatorMetre shrinks towards the poles and never goes negative', () => {
    assert.ok(P.trueMetresPerMercatorMetre(70) < P.trueMetresPerMercatorMetre(50));
    assert.ok(P.trueMetresPerMercatorMetre(90) >= 0);
    assert.ok(P.trueMetresPerMercatorMetre(-90) >= 0);
});

test('the scale factor explains the Mercator inflation it corrects', () => {
    // A footprint spanning N Mercator metres at 60 deg is half that in true metres.
    const lat = 60;
    const mercatorSpan = 100;
    closeTo(mercatorSpan * P.trueMetresPerMercatorMetre(lat), 50, 1e-9);
});

// -------------------------------------------------------------------------
// Module loading
// -------------------------------------------------------------------------
test('the module exports the documented surface', () => {
    const expected = [
        'R', 'MAX_MERCATOR_LAT', 'degToRad', 'latLonToMercator',
        'gpsToCartesian', 'getDatasetCentroid', 'long2tile', 'lat2tile',
        'tileSizeMeters', 'tileMercatorCenter', 'trueMetresPerMercatorMetre',
    ];
    expected.forEach(key => {
        assert.ok(key in P, `expected projection.js to export ${key}`);
    });
});
