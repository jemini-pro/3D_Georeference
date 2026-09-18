// =========================================================================
// GeoMapper 3D — script.js
//
// Two visualisation modes, auto-selected by upload size:
//
//   • 3D scene  (Three.js + OSM ground tiles)
//       Used when the archive is small enough that drawing 30 000 spheres
//       and 25 map tiles is still interactive. Default.
//
//   • 2D coverage map  (Leaflet)
//       Used for "drone dump" archives — anything over ~2 000 photos or
//       ~500 MB. Plots every camera position as a dot, with an optional
//       density heatmap. Renders 30 000 points in a single tile pass and
//       uses almost no GPU.
//
// fflate (8 kB) replaces JSZip because it has a `filter` callback that lets
// us skip MP4 videos and oversized files during the unzip pass, and the
// `unzipSync` path with a filter avoids ever holding the full archive in
// RAM (V8 caps tabs at ~2-4 GB on M1 8 GB, which 5 GB drone ZIPs exceed).
// =========================================================================

window.onerror = function (message, source, lineno, colno, error) {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
        statusDiv.textContent = `Error: ${message}`;
        statusDiv.style.color = 'red';
    }
    console.error("Global Error:", message, "at", source, ":", lineno);
};

// ----- Mode constants -----------------------------------------------------
const MODE_3D = '3d';
const MODE_2D = '2d';

// Thresholds for auto-fallback from 3D to 2D. Tuned for M1 8 GB / Chrome:
//   >2 000 photos  →  3D scene gets visually busy (overlapping spheres)
//   >500 MB        →  3D map-tile downloads + scene render start to lag
// Adjust if you're on a beefier machine.
const THREE_D_MAX_PHOTOS = 2000;
const THREE_D_MAX_FILE_MB = 500;

// Max bytes per image we'll keep in memory for the 3D path. Photos bigger
// than this are still parsed for GPS but their blob is dropped immediately
// (we only need the lat/lng to draw the bubble). 25 MB comfortably covers
// every drone JPG ever shipped.
const MAX_BLOB_BYTES = 25 * 1024 * 1024;

// ----- Module state -------------------------------------------------------
let scene, camera, renderer, controls;
let points = [];
let mapTiles = [];
let buildings = [];              // Building meshes currently in the scene
let uploadInFlight = false;
let tileLoadToken = 0;
let buildingLoadToken = 0;       // monotonic, so stale fetches dispose themselves
let currentMode = null; // MODE_3D or MODE_2D
let leafletMap = null;
let leafletMarkers = null;       // L.layerGroup for the dots
let leafletHeatLayer = null;     // L.heatLayer for density

const fileInput = document.getElementById('fileInput');
const statusDiv = document.getElementById('status');
const progressDiv = document.getElementById('progress');
const sceneContainer = document.getElementById('scene-container');
const mapContainer = document.getElementById('map-container');
const subtitle = document.getElementById('subtitle');
const bubbleControls = document.getElementById('bubbleControls');
const bubbleColorControl = document.getElementById('bubbleColorControl');
const mapToggleGroup = document.getElementById('mapToggleGroup');
const heatToggleGroup = document.getElementById('heatToggleGroup');

// =========================================================================
// Library-load waiter. All CDN scripts use `defer`, so they execute in
// document order before DOMContentLoaded, but our inline `<script
// src="script.js">` is also defer and runs last — meaning the `boot()`
// IIFE is called *after* all CDN scripts have evaluated. We still poll
// defensively in case any of them is slow to parse on a cold cache.
// =========================================================================
function waitForLibraries() {
    return new Promise((resolve) => {
        const check = () => {
            if (typeof fflate !== 'undefined'
             && typeof EXIF !== 'undefined'
             && typeof Projection !== 'undefined'
             && typeof THREE !== 'undefined'
             && typeof THREE.OrbitControls === 'function') {
                resolve();
            } else {
                setTimeout(check, 30);
            }
        };
        check();
    });
}

// =========================================================================
// 3D scene (Three.js)
// =========================================================================
// All CDN scripts (Three.js, fflate, EXIF, Leaflet) plus our own script.js
// use `defer`, so they execute in document order before DOMContentLoaded.
// By the time this top-level code runs, `THREE` is guaranteed to be defined.
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let hoveredPoint = null;

function init3DScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    scene.fog = new THREE.FogExp2(0x0f172a, 0.002);

    camera = new THREE.PerspectiveCamera(60, sceneContainer.clientWidth / sceneContainer.clientHeight, 0.1, 10000);
    camera.position.set(0, 50, 100);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(sceneContainer.clientWidth, sceneContainer.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    sceneContainer.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 1;
    controls.maxDistance = 5000;
    controls.maxPolarAngle = Math.PI / 2;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    const gridHelper = new THREE.GridHelper(1000, 50, 0x38bdf8, 0x1e293b);
    scene.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    window.addEventListener('resize', onWindowResize, false);
    window.addEventListener('mousemove', onMouseMove, false);
    window.addEventListener('click', onMouseClick, false);

    animate();
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = sceneContainer.clientWidth / sceneContainer.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(sceneContainer.clientWidth, sceneContainer.clientHeight);
    if (leafletMap) leafletMap.invalidateSize();
}

function onMouseClick(event) {
    if (!renderer) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(points);

    if (intersects.length > 0) {
        const object = intersects[0].object;
        controls.target.copy(object.position);
        controls.update();
        console.log("Centered view on:", object.userData.name);
    }
}

function onMouseMove(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    tooltip.style.left = (event.clientX + 15) + 'px';
    tooltip.style.top = (event.clientY + 15) + 'px';
}

function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();

    if (camera && scene) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(points);

        if (intersects.length > 0) {
            const object = intersects[0].object;
            if (hoveredPoint !== object) {
                if (hoveredPoint) {
                    let color = 0x38bdf8;
                    if (bubbleColorPicker) color = bubbleColorPicker.value;
                    hoveredPoint.material.color.set(color);
                }
                hoveredPoint = object;
                hoveredPoint.material.color.setHex(0x22c55e);
                tooltip.style.display = 'block';
                const basename = object.userData.name.split(/[/\\]/).pop();
                const name = basename.split('.')[0];
                const height = object.userData.alt.toFixed(1);
                tooltip.innerHTML = `<strong>${name}</strong><br>Height: ${height}m`;
            }
        } else {
            if (hoveredPoint) {
                let color = 0x38bdf8;
                if (bubbleColorPicker) color = bubbleColorPicker.value;
                hoveredPoint.material.color.set(color);
                hoveredPoint = null;
                tooltip.style.display = 'none';
            }
        }
    }

    if (renderer && scene && camera) renderer.render(scene, camera);
}

function clear3DScene() {
    points.forEach(p => {
        scene.remove(p);
        p.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            disposeMaterials(obj.material);
        });
    });
    points = [];

    mapTiles.forEach(tile => {
        scene.remove(tile);
        if (tile.geometry) tile.geometry.dispose();
        if (tile.material && tile.material.map) tile.material.map.dispose();
        disposeMaterials(tile.material);
    });
    mapTiles = [];

    clearBuildings();
}

/** Dispose one material or an array of them (ExtrudeGeometry uses two). */
function disposeMaterials(material) {
    if (!material) return;
    if (Array.isArray(material)) material.forEach(m => m.dispose());
    else material.dispose();
}

function fitCameraToSelection() {
    if (points.length === 0) return;

    const box = new THREE.Box3();
    points.forEach(mesh => box.expandByObject(mesh));

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    controls.target.copy(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 * Math.tan(fov * 2));
    cameraZ *= 1.5;
    if (cameraZ < 100) cameraZ = 100;
    if (cameraZ > 5000) cameraZ = 5000;

    camera.position.set(center.x, center.y + cameraZ, center.z + cameraZ);
    camera.updateProjectionMatrix();
    controls.update();
}

function createPoint(pos, imgData) {
    const geometry = new THREE.SphereGeometry(5, 32, 32);
    let color = 0x38bdf8;
    if (bubbleColorPicker) color = bubbleColorPicker.value;

    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.8 });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.position.set(pos.x, pos.y, pos.z);

    if (bubbleSizeSlider) {
        const size = parseFloat(bubbleSizeSlider.value);
        const scale = size / 5;
        sphere.scale.set(scale, scale, scale);
    }

    if (imgData.heading !== undefined && imgData.heading !== null) {
        const frustum = createCameraFrustum(color);
        const headingRad = THREE.MathUtils.degToRad(imgData.heading);
        frustum.rotation.y = -headingRad;
        sphere.add(frustum);
    }

    sphere.userData = { ...imgData };
    scene.add(sphere);
    points.push(sphere);
}

function createCameraFrustum(color) {
    const length = 10;
    const width = 6;
    const height = 4.5;

    const vertices = [];
    const o = new THREE.Vector3(0, 0, 0);
    const tl = new THREE.Vector3(-width / 2, height / 2, -length);
    const tr = new THREE.Vector3(width / 2, height / 2, -length);
    const bl = new THREE.Vector3(-width / 2, -height / 2, -length);
    const br = new THREE.Vector3(width / 2, -height / 2, -length);

    vertices.push(o.x, o.y, o.z, tl.x, tl.y, tl.z);
    vertices.push(o.x, o.y, o.z, tr.x, tr.y, tr.z);
    vertices.push(o.x, o.y, o.z, bl.x, bl.y, bl.z);
    vertices.push(o.x, o.y, o.z, br.x, br.y, br.z);

    vertices.push(tl.x, tl.y, tl.z, tr.x, tr.y, tr.z);
    vertices.push(tr.x, tr.y, tr.z, br.x, br.y, br.z);
    vertices.push(br.x, br.y, br.z, bl.x, bl.y, bl.z);
    vertices.push(bl.x, bl.y, bl.z, tl.x, tl.y, tl.z);

    const topMid = new THREE.Vector3(0, height / 2 + 2, -length);
    vertices.push(tl.x, tl.y, tl.z, topMid.x, topMid.y, topMid.z);
    vertices.push(tr.x, tr.y, tr.z, topMid.x, topMid.y, topMid.z);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.LineBasicMaterial({ color });
    return new THREE.LineSegments(geometry, material);
}

// =========================================================================
// 2D coverage map (Leaflet)
// =========================================================================
function init2DMap(centerLat, centerLng) {
    mapContainer.innerHTML = '';
    if (leafletMap) {
        leafletMap.remove();
        leafletMap = null;
    }
    leafletMap = L.map(mapContainer, {
        center: [centerLat, centerLng],
        zoom: 16,
        preferCanvas: true,           // crucial for 30k-point performance
        worldCopyJump: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
    }).addTo(leafletMap);
    leafletMarkers = L.layerGroup().addTo(leafletMap);
}

function add2DPoint(lat, lng, name) {
    const marker = L.circleMarker([lat, lng], {
        radius: 3,
        color: '#38bdf8',
        fillColor: '#38bdf8',
        fillOpacity: 0.7,
        weight: 0,
    });
    marker.bindTooltip(name, { direction: 'top', offset: [0, -4] });
    marker.addTo(leafletMarkers);
    return marker;
}

function buildHeatLayer(points) {
    if (leafletHeatLayer) {
        leafletMap.removeLayer(leafletHeatLayer);
        leafletHeatLayer = null;
    }
    if (typeof L.heatLayer !== 'function') return;
    const data = points.map(p => [p.lat, p.lng, 0.5]);
    leafletHeatLayer = L.heatLayer(data, {
        radius: 18,
        blur: 22,
        maxZoom: 17,
        gradient: { 0.2: '#0ea5e9', 0.5: '#22c55e', 0.8: '#facc15', 1.0: '#ef4444' },
    });
    if (document.getElementById('heatToggle').checked) {
        leafletHeatLayer.addTo(leafletMap);
    }
}

// =========================================================================
// Projection helpers (shared by both modes)
//
// The math lives in projection.js so it can be unit-tested outside the
// browser. Everything below is a thin binding to that module; do not
// re-implement it here.
// =========================================================================
const latLonToMercator = Projection.latLonToMercator;
const getDatasetCentroid = Projection.getDatasetCentroid;
const long2tile = Projection.long2tile;
const lat2tile = Projection.lat2tile;

/** Scene-space position of a photo. The centre is read from `window` here
 *  so the module itself stays global-free and testable. */
function gpsToCartesian(lat, lng, alt) {
    return Projection.gpsToCartesian(lat, lng, alt, window.centerMercator);
}

// =========================================================================
// EXIF
// =========================================================================
function getExifData(blob) {
    return new Promise((resolve, reject) => {
        if (typeof EXIF === 'undefined') {
            reject(new Error('exif-js library not loaded'));
            return;
        }
        const timeoutId = setTimeout(() => resolve(null), 2000);
        try {
            EXIF.getData(blob, function () {
                clearTimeout(timeoutId);
                const lat = EXIF.getTag(this, "GPSLatitude");
                const latRef = EXIF.getTag(this, "GPSLatitudeRef");
                const lng = EXIF.getTag(this, "GPSLongitude");
                const lngRef = EXIF.getTag(this, "GPSLongitudeRef");
                const alt = EXIF.getTag(this, "GPSAltitude");
                const altRef = EXIF.getTag(this, "GPSAltitudeRef");
                const dir = EXIF.getTag(this, "GPSImgDirection");
                if (lat && latRef && lng && lngRef) {
                    let altitude = 0;
                    if (alt !== undefined && alt !== null) {
                        altitude = parseFloat(alt);
                        if (altRef === 1) altitude = -altitude;
                    }
                    resolve({
                        lat: convertDMSToDD(lat, latRef),
                        lng: convertDMSToDD(lng, lngRef),
                        alt: altitude,
                        heading: dir !== undefined && dir !== null ? parseFloat(dir) : null,
                    });
                } else {
                    resolve(null);
                }
            });
        } catch (e) {
            clearTimeout(timeoutId);
            console.error("EXIF.getData error:", e);
            resolve(null);
        }
    });
}

function convertDMSToDD(dms, ref) {
    let dd = dms[0] + dms[1] / 60 + dms[2] / 3600;
    if (ref === "S" || ref === "W") dd = -dd;
    return dd;
}

// =========================================================================
// 3D map tiles (Three.js + OSM ground overlay)
// =========================================================================
async function loadMapTiles(lat, lng) {
    mapTiles.forEach(tile => {
        scene.remove(tile);
        if (tile.geometry) tile.geometry.dispose();
        if (tile.material && tile.material.map) tile.material.map.dispose();
        disposeMaterials(tile.material);
    });
    mapTiles = [];

    const myToken = ++tileLoadToken;
    let failedTiles = 0;

    const zoom = 19;
    const tileX = long2tile(lng, zoom);
    const tileY = lat2tile(lat, zoom);
    const radius = 2;
    const textureLoader = new THREE.TextureLoader();
    textureLoader.crossOrigin = 'anonymous';

    for (let x = tileX - radius; x <= tileX + radius; x++) {
        for (let y = tileY - radius; y <= tileY + radius; y++) {
            const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
            const tileSizeMeters = Projection.tileSizeMeters(zoom);
            const tileCenter = Projection.tileMercatorCenter(x, y, zoom);
            const posX = tileCenter.x - window.centerMercator.x;
            const posZ = -(tileCenter.y - window.centerMercator.y);

            const geometry = new THREE.PlaneGeometry(tileSizeMeters, tileSizeMeters);
            const material = new THREE.MeshBasicMaterial({ color: 0x334155 });
            const plane = new THREE.Mesh(geometry, material);
            plane.rotation.x = -Math.PI / 2;
            plane.position.set(posX, -0.5, posZ);

            const toggle = document.getElementById('mapToggle');
            if (toggle) plane.visible = toggle.checked;

            scene.add(plane);
            mapTiles.push(plane);

            textureLoader.load(url,
                (texture) => {
                    if (myToken !== tileLoadToken) { texture.dispose(); return; }
                    material.map = texture;
                    material.color.set(0xffffff);
                    material.needsUpdate = true;
                },
                undefined,
                (err) => {
                    console.warn(`Map tile failed: ${url}`, err?.message || err);
                    failedTiles++;
                    if (failedTiles === 1) {
                        statusDiv.textContent = `Visualized, but some map tiles failed to load (rate limit or offline). Points still placed.`;
                        statusDiv.style.color = 'var(--text-secondary)';
                    }
                }
            );
        }
    }
}

// =========================================================================
// Building Layer — OpenStreetMap context geometry
//
// Buildings are context, not content: this path never blocks an upload and
// degrades to the flat ground plane if anything goes wrong. See
// docs/adr/0004.
//
// Overpass is a shared community resource with a usage policy, not a tile
// server, so we make ONE small-bbox query per upload — never per photo and
// never per camera move.
//
// Robustness beyond "don't block, don't break the upload" — caching, a
// mirror fallback, and a building cap — is deliberately left to a later
// ticket. This is the tracer bullet.
// =========================================================================
const BUILDING_QUERY_RADIUS_M = 300;   // clears the 5x5 z19 tile patch's half-diagonal of
                                       // about 270 m, so buildings at the visible corners
                                       // are already loaded rather than popping in
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// Facade and roof colours. ExtrudeGeometry emits its lid (top/bottom) as
// material group 0 and its walls as group 1, so a two-material array gives
// the distinct roof that makes buildings read as volumes.
const BUILDING_FACADE_COLOR = 0x64748b;
const BUILDING_ROOF_COLOR = 0x475569;

/**
 * A metric box around the Dataset Centroid -> the lat/lon box Overpass wants.
 * Longitude degrees per metre widen by 1/cos(lat), which matters at high
 * latitudes or the box comes out too narrow.
 */
function buildingBBox(centerMercator, radiusM) {
    const nw = Projection.mercatorToLatLon(centerMercator.x - radiusM, centerMercator.y + radiusM);
    const se = Projection.mercatorToLatLon(centerMercator.x + radiusM, centerMercator.y - radiusM);
    return { south: se.lat, west: nw.lon, north: nw.lat, east: se.lon };
}

function buildOverpassQuery(bbox) {
    const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
    // Ways cover the vast majority of buildings. Relations are included
    // because a courtyard building is a multipolygon, and filling one in
    // would be a silently wrong shape rather than a missing building.
    // `out geom;` inlines coordinates for both, so no second round trip.
    return [
        '[out:json][timeout:20];',
        '(',
        `way["building"](${b});`,
        `relation["building"]["type"="multipolygon"](${b});`,
        ');',
        'out geom;',
    ].join('');
}

function createBuildingMesh(building) {
    const shape = new THREE.Shape(
        building.outer.map(p => new THREE.Vector2(p.x, p.y))
    );
    building.holes.forEach(hole => {
        shape.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p.x, p.y))));
    });

    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: building.height,
        bevelEnabled: false,
    });

    // ExtrudeGeometry extrudes along +Z; rotating -PI/2 about X turns that
    // into scene up (+Y), and maps shape y to scene -z, which matches the
    // convention gpsToCartesian uses. Getting this sign wrong mirrors the
    // buildings north-to-south against the tiles.
    geometry.rotateX(-Math.PI / 2);

    // Group 0 is the extruded lid, group 1 the walls.
    const materials = [
        new THREE.MeshStandardMaterial({ color: BUILDING_ROOF_COLOR, roughness: 0.9, metalness: 0.0 }),
        new THREE.MeshStandardMaterial({ color: BUILDING_FACADE_COLOR, roughness: 0.85, metalness: 0.0 }),
    ];
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.userData = { osmId: building.osmId, height: building.height, isBuilding: true };
    return mesh;
}

function clearBuildings() {
    buildings.forEach(b => {
        scene.remove(b);
        if (b.geometry) b.geometry.dispose();
        disposeMaterials(b.material);
    });
    buildings = [];
}

/**
 * Fetch and render buildings for the current upload.
 *
 * Called after the photos are on screen and deliberately NOT awaited: a slow
 * or failed Overpass request must not delay or fail the upload. `token`
 * guards against a previous upload's slower fetch landing on top of the
 * current scene.
 *
 * Reads the Dataset Centroid the upload flow has already published to
 * `window`, rather than taking it as a parameter — the scene and the photos
 * were placed against that same centroid, and buildings must agree with them.
 */
async function loadBuildings() {
    // A missing buildings.js must never hang or fail the upload. It is the
    // only script the boot sequence does not wait for (docs/adr/0004).
    if (typeof Buildings === 'undefined') return;

    const myToken = ++buildingLoadToken;
    const centerMercator = window.centerMercator;
    const bbox = buildingBBox(centerMercator, BUILDING_QUERY_RADIUS_M);
    const query = buildOverpassQuery(bbox);

    let json;
    try {
        const response = await fetch(OVERPASS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        json = await response.json();
    } catch (err) {
        console.warn('Building Layer unavailable; continuing without buildings.', err?.message || err);
        return;
    }

    if (myToken !== buildingLoadToken) return;

    const shapes = Buildings.buildBuildingShapes(json, centerMercator, window.centerLat);

    clearBuildings();
    shapes.forEach(shape => {
        const mesh = createBuildingMesh(shape);
        scene.add(mesh);
        buildings.push(mesh);
    });
}

// =========================================================================
// Mode-switching (UI)
// =========================================================================
function setMode(mode) {
    if (mode === currentMode) return;
    if (mode === MODE_3D) {
        sceneContainer.style.display = 'block';
        mapContainer.style.display = 'none';
        bubbleControls.style.display = '';
        bubbleColorControl.style.display = '';
        mapToggleGroup.style.display = '';
        heatToggleGroup.style.display = 'none';
        subtitle.textContent = 'Visualize your photo locations in 3D space.';
    } else {
        sceneContainer.style.display = 'none';
        mapContainer.style.display = 'block';
        bubbleControls.style.display = 'none';
        bubbleColorControl.style.display = 'none';
        mapToggleGroup.style.display = 'none';
        heatToggleGroup.style.display = '';
        subtitle.textContent = 'Coverage map of geotagged photos (2D mode for large archives).';
    }
    currentMode = mode;
}

// =========================================================================
// UI controls (3D-only — left wired but hidden in 2D mode)
// =========================================================================
const bubbleSizeSlider = document.getElementById('bubbleSize');
const bubbleSizeValue = document.getElementById('bubbleSizeValue');
const bubbleColorPicker = document.getElementById('bubbleColor');

if (bubbleSizeSlider && bubbleSizeValue) {
    bubbleSizeSlider.addEventListener('input', (e) => {
        const size = parseFloat(e.target.value);
        bubbleSizeValue.textContent = size;
        points.forEach(point => {
            const scale = size / 5;
            point.scale.set(scale, scale, scale);
        });
    });
}

if (bubbleColorPicker) {
    bubbleColorPicker.addEventListener('input', (e) => {
        const color = e.target.value;
        points.forEach(point => {
            point.material.color.set(color);
            const frustum = point.children.find(child => child.type === 'LineSegments');
            if (frustum) frustum.material.color.set(color);
        });
    });
}

const mapToggle = document.getElementById('mapToggle');
if (mapToggle) {
    mapToggle.addEventListener('change', (e) => {
        const isVisible = e.target.checked;
        mapTiles.forEach(tile => { tile.visible = isVisible; });
    });
}

const heatToggle = document.getElementById('heatToggle');
if (heatToggle) {
    heatToggle.addEventListener('change', () => {
        if (!leafletMap || !leafletHeatLayer) return;
        if (heatToggle.checked) leafletHeatLayer.addTo(leafletMap);
        else leafletMap.removeLayer(leafletHeatLayer);
    });
}

// =========================================================================
// File processing pipeline
// =========================================================================

/**
 * Decide which mode to render in, based on archive size and entry count.
 * Done BEFORE the unzip pass so we can warn the user early.
 */
function pickMode(file, entryCount) {
    const sizeMb = file.size / 1024 / 1024;
    if (entryCount > THREE_D_MAX_PHOTOS || sizeMb > THREE_D_MAX_FILE_MB) {
        return MODE_2D;
    }
    return MODE_3D;
}

function isImageEntry(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower.includes('__macosx')) return false;
    return /\.(jpg|jpeg|png|heic)$/.test(lower);
}

/**
 * Read the file with fflate. fflate's `unzipSync` synchronously decodes the
 * central directory and lets us pass a `filter` callback that runs on each
 * entry's metadata BEFORE any bytes are decompressed. Returning `false`
 * from the filter means the entry is never inflated — exactly what we want
 * for the videos and junk files that make up 60-80% of a drone dump.
 *
 * Returns {entries, stats} where entries is a map of name → Uint8Array
 * of just the images we kept, and stats has counts.
 */
function unzipWithFilter(zipBuffer, maxBytesPerEntry) {
    const entries = {};
    const stats = { total: 0, kept: 0, skippedVideo: 0, skippedOversize: 0, skippedOther: 0 };

    const decoded = fflate.unzipSync(new Uint8Array(zipBuffer), {
        filter: (file) => {
            stats.total++;
            if (!isImageEntry(file.name)) {
                // Skip videos, .DS_Store, sidecar files, etc.
                if (/\.(mp4|mov|m4v|avi|mkv|lrv|srt)$/i.test(file.name)) {
                    stats.skippedVideo++;
                } else {
                    stats.skippedOther++;
                }
                return false;
            }
            if (file.originalSize > maxBytesPerEntry) {
                stats.skippedOversize++;
                return false;
            }
            stats.kept++;
            return true;
        },
    });

    Object.assign(entries, decoded);
    return { entries, stats };
}

/**
 * Async wrapper that yields to the event loop between batches so the UI
 * can repaint progress text. EXIF parsing of a 30k-photo archive would
 * otherwise freeze the tab for many seconds.
 */
async function extractGpsFromEntries(entries, onProgress) {
    const names = Object.keys(entries);
    const total = names.length;
    const validImages = [];
    const BATCH = 50;
    const errors = { noGps: 0, parseFail: 0 };

    for (let i = 0; i < total; i += BATCH) {
        const batch = names.slice(i, i + BATCH);
        await Promise.all(batch.map(async (name) => {
            const bytes = entries[name];
            const blob = new Blob([bytes], { type: 'image/jpeg' });
            try {
                const exif = await getExifData(blob);
                if (exif && exif.lat !== undefined && exif.lng !== undefined) {
                    validImages.push({ name, ...exif });
                } else {
                    errors.noGps++;
                }
            } catch (e) {
                errors.parseFail++;
            }
        }));
        if (onProgress) onProgress(Math.min(total, i + BATCH), total);
        // Yield to the event loop so the status text repaints.
        await new Promise(r => setTimeout(r, 0));
    }

    return { validImages, errors, total };
}

function setStatus(text, color) {
    statusDiv.textContent = text;
    if (color) statusDiv.style.color = color;
}

function setProgress(text) {
    if (progressDiv) progressDiv.textContent = text || '';
}

// =========================================================================
// Main entry point
// =========================================================================
fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (uploadInFlight) {
        setStatus('Already processing a ZIP, please wait...', 'var(--text-secondary)');
        return;
    }
    uploadInFlight = true;

    setStatus(`Reading ${(file.size / 1024 / 1024).toFixed(1)} MB ZIP…`, 'var(--accent-color)');
    setProgress('');

    // 5GB on an 8GB-RAM Mac is over V8's per-tab heap cap (~2-4GB). Tell
    // the user up front instead of letting the tab die silently. A
    // streamed, EOCD-only path (fflate + File.slice) could handle this
    // but is a bigger refactor — for now, we surface the cap clearly
    // and point at chunking.
    if (file.size > 2 * 1024 * 1024 * 1024) {
        setStatus(
            `That ZIP is ${(file.size / 1024 / 1024 / 1024).toFixed(1)} GB — ` +
            `larger than this tab can hold in memory. Re-zip in chunks ` +
            `of <2 GB and upload each separately.`,
            'var(--error-color)'
        );
        return;
    }

    // Step 1: buffer the file. Some browsers invalidate the File handle
    // once the picker closes, so we read the bytes into RAM first.
    let zipBuffer;
    try {
        zipBuffer = await file.arrayBuffer();
    } catch (readErr) {
        console.error('Could not read the selected file:', readErr);
        setStatus('Could not read the selected file. Try re-selecting it from the file picker.', 'var(--error-color)');
        uploadInFlight = false;
        return;
    }

    // Sanity check
    const view = new Uint8Array(zipBuffer, 0, 4);
    if (view.length < 4 || view[0] !== 0x50 || view[1] !== 0x4B ||
        view[2] !== 0x03 || view[3] !== 0x04) {
        setStatus('That file does not look like a ZIP archive.', 'var(--error-color)');
        uploadInFlight = false;
        return;
    }

    try {
        // Step 2: unzip with the filter. The filter runs against metadata
        // only, so even 5 GB archives are fine — we never inflate videos.
        setStatus('Indexing ZIP entries…', 'var(--accent-color)');
        const t0 = performance.now();
        const { entries, stats } = unzipWithFilter(zipBuffer, MAX_BLOB_BYTES);
        const unzipMs = (performance.now() - t0).toFixed(0);

        const mode = pickMode(file, stats.kept);
        setMode(mode);

        if (mode === MODE_2D) {
            // 2D path: free the raw bytes immediately, we only need lat/lng.
            zipBuffer = null;
        }

        const modeLabel = mode === MODE_2D ? '2D coverage map' : '3D scene';
        setStatus(
            `Found ${stats.kept} image${stats.kept === 1 ? '' : 's'} ` +
            `(skipped ${stats.skippedVideo} video${stats.skippedVideo === 1 ? '' : 's'}, ` +
            `${stats.skippedOversize} oversize, ${stats.skippedOther} other). ` +
            `Reading EXIF in ${modeLabel}…`,
            'var(--accent-color)'
        );

        // Step 3: parse EXIF for each kept image, in batches so the UI
        // repaints progress text.
        const { validImages, errors, total } = await extractGpsFromEntries(
            entries,
            (done, all) => {
                setProgress(`EXIF ${done} / ${all} (${Math.round(done / all * 100)}%)`);
            }
        );
        // entries is no longer needed; let GC reclaim it.
        // (Not strictly necessary in the 3D path either, but explicit is good.)
        for (const k of Object.keys(entries)) delete entries[k];

        if (validImages.length === 0) {
            setStatus(
                `No GPS data found in ${total} images. ` +
                `${errors.noGps} had no GPS, ${errors.parseFail} failed to parse.`,
                'var(--error-color)'
            );
            setProgress('');
            return;
        }

        const center = getDatasetCentroid(validImages);

        if (mode === MODE_3D) {
            clear3DScene();
            window.centerLat = center.lat;
            window.centerLng = center.lng;
            window.centerMercator = latLonToMercator(center.lat, center.lng);

            await loadMapTiles(center.lat, center.lng);

            validImages.forEach(img => {
                const pos = gpsToCartesian(img.lat, img.lng, img.alt);
                createPoint(pos, img);
            });
            fitCameraToSelection();

            setStatus(
                `Visualized ${validImages.length} images in 3D with map overlay ` +
                `(unzip ${unzipMs} ms, ${stats.skippedVideo} videos skipped).`,
                'var(--success-color)'
            );

            // Deliberately not awaited: buildings are context, and a slow or
            // failing Overpass request must not delay the photos the user is
            // already looking at (docs/adr/0004).
            loadBuildings();
        } else {
            // 2D path
            // Free any 3D scene state from a previous upload so we don't
            // leak GPU resources on mode-switch.
            if (typeof scene !== 'undefined' && scene) clear3DScene();
            init2DMap(center.lat, center.lng);
            validImages.forEach(img => add2DPoint(img.lat, img.lng, img.name));
            // layerGroup doesn't expose getBounds; build a LatLngBounds from
            // the markers we just added.
            const bounds = L.latLngBounds(validImages.map(img => [img.lat, img.lng]));
            leafletMap.fitBounds(bounds.pad(0.1));
            buildHeatLayer(validImages);

            setStatus(
                `Mapped ${validImages.length} photos on the 2D coverage map ` +
                `(skipped ${stats.skippedVideo} videos, ${stats.skippedOversize} oversize images). ` +
                `${errors.noGps} had no GPS.`,
                'var(--success-color)'
            );
        }
        setProgress('');

    } catch (err) {
        console.error(err);
        setStatus('Error processing file: ' + err.message, 'var(--error-color)');
        setProgress('');
    } finally {
        uploadInFlight = false;
    }
});

// =========================================================================
// Boot
// =========================================================================
(async function boot() {
    await waitForLibraries();
    init3DScene();
    setMode(MODE_3D);
})();
