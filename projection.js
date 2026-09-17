// =========================================================================
// GeoMapper 3D — projection.js
//
// Pure coordinate and geometry-scale math. No DOM, no Three.js, no globals:
// loaded as a plain <script> in the browser (exposing `Projection`) and via
// `require` in Node for the test suite. This is what makes the projection
// testable outside a live page.
//
// Two coordinate conventions live here and they are NOT the same thing:
//
//   • Mercator metres — the horizontal frame. Distances in it are inflated
//     by 1/cos(latitude) relative to true metres on the ground.
//   • True metres — altitudes and OSM building heights.
//
// `trueMetresPerMercatorMetre()` converts between them, for the Building
// Layer that will consume it. That layer does not exist yet; the distinction
// is deliberate and documented in
// docs/adr/0002-footprints-scaled-to-true-metres.md, which is worth reading
// before "fixing" anything here.
// =========================================================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.Projection = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const R = 6378137;
    const MAX_MERCATOR_LAT = 85.05112878;
    const TWO_PI_R = 2 * Math.PI * R;
    const HALF_WORLD = Math.PI * R;

    function degToRad(deg) {
        return deg * Math.PI / 180;
    }

    /**
     * WGS84 lat/lon -> Web Mercator metres (EPSG:3857). Latitudes beyond the
     * Mercator limit are clamped, because the projection is undefined there
     * and the log would diverge.
     */
    function latLonToMercator(lat, lon) {
        const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
        const x = R * degToRad(lon);
        const y = R * Math.log(Math.tan(Math.PI / 4 + degToRad(clampedLat) / 2));
        return { x, y };
    }

    /**
     * GPS -> the scene's local metre frame: Web Mercator relative to the
     * Dataset Centroid, Y-up (so altitude is free for Y), with an
     * antimeridian wrap so points either side of the dateline stay close
     * together.
     *
     * The centroid is passed in rather than read from a global so this is
     * callable from tests.
     */
    function gpsToCartesian(lat, lng, alt, centerMercator) {
        const mercator = latLonToMercator(lat, lng);
        let dx = mercator.x - centerMercator.x;
        if (dx > TWO_PI_R / 2) dx -= TWO_PI_R;
        if (dx < -TWO_PI_R / 2) dx += TWO_PI_R;
        return { x: dx, y: alt, z: -(mercator.y - centerMercator.y) };
    }

    /** Mid-point of the bounding box of a set of {lat, lng} points. */
    function getDatasetCentroid(images) {
        let minLat = Infinity, maxLat = -Infinity;
        let minLng = Infinity, maxLng = -Infinity;
        images.forEach(img => {
            minLat = Math.min(minLat, img.lat);
            maxLat = Math.max(maxLat, img.lat);
            minLng = Math.min(minLng, img.lng);
            maxLng = Math.max(maxLng, img.lng);
        });
        return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
    }

    /** Slippy-map tile index for a longitude at a zoom level. */
    function long2tile(lon, zoom) {
        return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
    }

    /** Slippy-map tile index for a latitude at a zoom level. */
    function lat2tile(lat, zoom) {
        return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    }

    /** Edge length of one tile at a zoom level, in Mercator metres. */
    function tileSizeMeters(zoom) {
        return TWO_PI_R / Math.pow(2, zoom);
    }

    /** Mercator centre point of a tile, for placing it in the scene. */
    function tileMercatorCenter(x, y, zoom) {
        const n = Math.pow(2, zoom);
        return {
            x: ((x + 0.5) / n) * TWO_PI_R - HALF_WORLD,
            y: HALF_WORLD - ((y + 0.5) / n) * TWO_PI_R,
        };
    }

    /**
     * How many true metres one Mercator metre represents at a latitude.
     * Mercator inflates distances by 1/cos(lat), so this is cos(lat):
     * 1.0 at the equator, 0.5 at 60 degrees. Multiply a Mercator-measured
     * horizontal extent by this to get its true-metre extent.
     */
    function trueMetresPerMercatorMetre(lat) {
        return Math.cos(degToRad(Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))));
    }

    return {
        R,
        MAX_MERCATOR_LAT,
        degToRad,
        latLonToMercator,
        gpsToCartesian,
        getDatasetCentroid,
        long2tile,
        lat2tile,
        tileSizeMeters,
        tileMercatorCenter,
        trueMetresPerMercatorMetre,
    };
});
