// =========================================================================
// Tests for terrain.js — Open-Meteo Copernicus DEM GLO-90 elevation lookup.
//
//   node --test
//
// The fetch is injected so the lookup logic is testable without a network
// or a mocking library; the browser and Node both hand it their global
// `fetch`.
// =========================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./terrain.js');

const closeTo = (actual, expected, tolerance, msg) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        msg || `expected ${actual} to be within ${tolerance} of ${expected}`
    );
};

// -------------------------------------------------------------------------
// buildElevationUrl
// -------------------------------------------------------------------------
test('buildElevationUrl encodes a single point', () => {
    const url = T.buildElevationUrl([{ lat: 51.5007, lon: -0.1246 }]);
    assert.ok(url.startsWith('https://api.open-meteo.com/v1/elevation?'));
    assert.match(url, /latitude=51\.5007/);
    assert.match(url, /longitude=-0\.1246/);
});

test('buildElevationUrl encodes many points as comma-separated arrays', () => {
    const url = T.buildElevationUrl([
        { lat: 51.5007, lon: -0.1246 },
        { lat: 51.5012, lon: -0.1242 },
        { lat: 51.5003, lon: -0.1252 },
    ]);
    assert.match(url, /latitude=51\.5007,51\.5012,51\.5003/);
    assert.match(url, /longitude=-0\.1246,-0\.1242,-0\.1252/);
});

// -------------------------------------------------------------------------
// chunkCoords
// -------------------------------------------------------------------------
test('chunkCoords splits a large set into 100-coordinate batches', () => {
    const coords = Array.from({ length: 250 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 0 }));
    const chunks = T.chunkCoords(coords, 100);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 100);
    assert.equal(chunks[1].length, 100);
    assert.equal(chunks[2].length, 50);
});

test('chunkCoords returns a single batch for a small set', () => {
    const coords = Array.from({ length: 3 }, (_, i) => ({ lat: 51.5, lon: -0.12 + i * 0.001 }));
    assert.equal(T.chunkCoords(coords, 100).length, 1);
});

test('chunkCoords returns [] for no coordinates', () => {
    assert.deepEqual(T.chunkCoords([], 100), []);
});

// -------------------------------------------------------------------------
// extractElevations
// -------------------------------------------------------------------------
test('extractElevations reads the elevation array out of the response', () => {
    const elevations = T.extractElevations({ elevation: [8.0, 13.0, 6.0] });
    assert.deepEqual(elevations, [8.0, 13.0, 6.0]);
});

test('extractElevations returns null for a malformed response', () => {
    assert.equal(T.extractElevations(null), null);
    assert.equal(T.extractElevations({}), null);
    assert.equal(T.extractElevations({ elevation: 'bad' }), null);
});

test('extractElevations returns null when the response is an error object', () => {
    assert.equal(T.extractElevations({ error: true, reason: 'oops' }), null);
});

// -------------------------------------------------------------------------
// fetchTerrainElevations
// -------------------------------------------------------------------------
test('fetchTerrainElevations resolves elevations for a small set', async () => {
    const fetch = async (url) => ({
        ok: true,
        json: async () => ({ elevation: [8.0, 13.0, 6.0] }),
    });
    const out = await T.fetchTerrainElevations([
        { lat: 51.5007, lon: -0.1246 },
        { lat: 51.5012, lon: -0.1240 },
        { lat: 51.5003, lon: -0.1252 },
    ], { fetch });
    assert.deepEqual(out, [8.0, 13.0, 6.0]);
});

test('fetchTerrainElevations batches over 100 coordinates', async () => {
    let calls = 0;
    const fetch = async (url) => {
        calls++;
        const latParams = url.match(/latitude=([^&]+)/)[1].split(',').length;
        return {
            ok: true,
            json: async () => ({ elevation: new Array(latParams).fill(1) }),
        };
    };
    const coords = Array.from({ length: 250 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 0 }));
    const out = await T.fetchTerrainElevations(coords, { fetch });
    assert.equal(calls, 3, 'must fan out one request per 100-coordinate batch');
    assert.equal(out.length, 250);
});

test('fetchTerrainElevations returns null elevations for a failed batch', async () => {
    const fetch = async () => ({ ok: false, status: 429 });
    const out = await T.fetchTerrainElevations([
        { lat: 51.5, lon: -0.12 },
        { lat: 51.6, lon: -0.13 },
    ], { fetch });
    assert.deepEqual(out, [null, null]);
});

test('fetchTerrainElevations handles a malformed response body', async () => {
    const fetch = async () => ({ ok: true, json: async () => ({ error: true, reason: 'bad' }) });
    const out = await T.fetchTerrainElevations([{ lat: 51.5, lon: -0.12 }], { fetch });
    assert.deepEqual(out, [null]);
});

test('fetchTerrainElevations returns [] for no coordinates without fetching', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return { ok: true, json: async () => ({}) }; };
    assert.deepEqual(await T.fetchTerrainElevations([], { fetch }), []);
    assert.equal(calls, 0);
});

test('fetchTerrainElevations uses global fetch by default', async () => {
    assert.equal(typeof fetch, 'function', 'Node 18+ provides global fetch');
    const out = await T.fetchTerrainElevations([
        { lat: 51.5007, lon: -0.1246 },
    ]);
    assert.ok(Number.isFinite(out[0]), 'live endpoint must resolve a number');
    closeTo(out[0], 8.0, 20, 'Big Ben sits on low ground near the Thames');
});

test('fetchTerrainElevations survives a network throw as nulls', async () => {
    const fetch = async () => { throw new Error('network down'); };
    const out = await T.fetchTerrainElevations([{ lat: 51.5, lon: -0.12 }], { fetch });
    assert.deepEqual(out, [null]);
});

// -------------------------------------------------------------------------
// rebaseElevations — the Ground Reference shift (ADR-0006)
// -------------------------------------------------------------------------
test('rebaseElevations measures every point above the ground reference', () => {
    const out = T.rebaseElevations([1599, 1610, 1580], 1599);
    assert.deepEqual(out, [0, 11, -19]);
});

test('rebaseElevations maps the reference itself to zero', () => {
    assert.deepEqual(T.rebaseElevations([2920], 2920), [0]);
});

test('rebaseElevations preserves relief between points', () => {
    const out = T.rebaseElevations([10, 30, 20], 10);
    assert.equal(out[1] - out[0], 20, 'differences are unchanged by the shift');
    assert.equal(out[2] - out[0], 10);
});

test('rebaseElevations passes missing points through as null', () => {
    assert.deepEqual(T.rebaseElevations([100, null, 120], 100), [0, null, 20]);
});

test('rebaseElevations returns all nulls when the reference is unresolved', () => {
    assert.deepEqual(T.rebaseElevations([100, 120], null), [null, null]);
    assert.deepEqual(T.rebaseElevations([100, 120], undefined), [null, null]);
});

test('rebaseElevations handles an empty list', () => {
    assert.deepEqual(T.rebaseElevations([], 100), []);
});

// -------------------------------------------------------------------------
// Module loading
// -------------------------------------------------------------------------
test('the module exports the documented surface', () => {
    const expected = [
        'buildElevationUrl', 'chunkCoords', 'extractElevations',
        'fetchTerrainElevations', 'rebaseElevations',
    ];
    expected.forEach(key => assert.ok(key in T, `expected terrain.js to export ${key}`));
});

test('the module loads with no DOM present', () => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof T.fetchTerrainElevations, 'function');
});
