// =========================================================================
// GeoMapper 3D — terrain.js
//
// Pure elevation lookup against the keyless Open-Meteo Copernicus DEM
// GLO-90 endpoint. No DOM, no globals: loaded as a plain <script> in the
// browser (exposing `Terrain`) and via `require` in Node for the test
// suite, with `fetch` injected so the lookup logic is testable offline.
//
// Terrain Elevation is deliberately coarse (90 m surface model that
// includes buildings and vegetation) and is used for exactly one thing:
// sitting buildings on the land. Per docs/adr/0003, nothing photo-relative
// may be derived from it or shown. A failed or rate-limited lookup must
// never fail the upload — callers receive `null` per missing point and
// degrade to the flat sea-level ground.
//
// `fetchTerrainElevations` returns absolute metres above sea level; the
// caller re-bases them onto the scene's Ground Reference with
// `rebaseElevations` (docs/adr/0006).
// =========================================================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.Terrain = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';

    // The API caps a single request at 100 coordinates.
    const BATCH_SIZE = 100;

    /**
     * The Elevation API URL for a set of {lat, lon} points, with latitude
     * and longitude as the comma-separated arrays the endpoint expects.
     */
    function buildElevationUrl(coords) {
        const lats = coords.map(c => c.lat).join(',');
        const lons = coords.map(c => c.lon).join(',');
        return `${ELEVATION_ENDPOINT}?latitude=${lats}&longitude=${lons}`;
    }

    /**
     * Split a coordinate list into <= `size`-point batches, preserving
     * order so results zip back onto the input.
     */
    function chunkCoords(coords, size) {
        const chunks = [];
        for (let i = 0; i < coords.length; i += size) {
            chunks.push(coords.slice(i, i + size));
        }
        return chunks;
    }

    /**
     * Pull the elevation array out of a response. Returns null when the
     * body is missing, malformed, or an Open-Meteo error object — the
     * caller then treats every point as unresolved.
     */
    function extractElevations(json) {
        if (!json || json.error || !Array.isArray(json.elevation)) return null;
        return json.elevation;
    }

    /**
     * Resolve Terrain Elevation for every {lat, lon} in `coords`.
     *
     * Returns an array the same length as `coords` where each entry is a
     * metres-above-sea-level number or `null` when that point's batch
     * failed or was malformed. Never throws: every failure mode degrades
     * to `null` so the caller can keep rendering on flat ground.
     *
     * `opts.fetch` defaults to the global fetch so the browser and Node
     * just work; tests inject a stub.
     */
    async function fetchTerrainElevations(coords, opts) {
        const doFetch = (opts && opts.fetch) || fetch;
        if (coords.length === 0) return [];

        const batches = chunkCoords(coords, BATCH_SIZE);
        const results = await Promise.all(batches.map(async (batch) => {
            try {
                const response = await doFetch(buildElevationUrl(batch));
                if (!response.ok) return batch.map(() => null);
                const json = await response.json();
                const elevations = extractElevations(json);
                if (elevations === null) return batch.map(() => null);
                return elevations;
            } catch (err) {
                return batch.map(() => null);
            }
        }));

        return results.flat();
    }

    /**
     * Re-base absolute sea-level elevations onto the Ground Reference: each
     * result is its height (metres) above that reference, so relief between
     * points survives while the reference itself maps to 0 — the scene's
     * flat ground plane.
     *
     * The whole scene shares one Ground Reference (the Terrain Elevation
     * under the Dataset Centroid), so a building's base lands on the plane
     * the ground tiles sit on rather than at its absolute sea-level height,
     * which would leave it floating on any elevated site (docs/adr/0006).
     *
     * A missing point stays `null`. If the reference itself is unresolved
     * every result is `null`, so the caller degrades to the flat plane for
     * the whole Building Layer rather than guessing an offset.
     */
    function rebaseElevations(elevations, groundReference) {
        if (groundReference === null || groundReference === undefined) {
            return elevations.map(() => null);
        }
        return elevations.map(e =>
            (e === null || e === undefined) ? null : e - groundReference
        );
    }

    return {
        ELEVATION_ENDPOINT,
        BATCH_SIZE,
        buildElevationUrl,
        chunkCoords,
        extractElevations,
        fetchTerrainElevations,
        rebaseElevations,
    };
});
