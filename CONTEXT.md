# GeoMapper 3D

A drag-and-drop visualiser that plots geotagged photos in 3D space so you can
see where a shoot happened, which way each camera was pointing, and how the
shots relate to the buildings around them.

## Language

**Photo**:
An image extracted from an uploaded ZIP that carries GPS coordinates in its
EXIF. A photo without GPS is not a Photo for the purposes of this app.
_Avoid_: image, asset, file

**Photo Pose**:
A photo's position and orientation as read from EXIF — latitude, longitude,
altitude and heading. This is the only placement input the app uses.
_Avoid_: geotag, location, position

**Scene Space**:
The app's local true-metre coordinate frame: Web Mercator relative to the
Dataset Centroid, scaled horizontally by cos(centroid latitude) so every
horizontal extent is true metres, Y-up so that `y` is altitude. All geometry
in the 3D scene lives in this space; the one frame scale is shared by photo
positions, ground tiles, and building footprints (docs/adr/0005).
_Avoid_: world space, model space, map space

**Dataset Centroid**:
The mid-point of the bounding box of all photos in an upload. It is the origin
of Scene Space, so an upload's geometry is always centred on itself.
_Avoid_: centre, origin, anchor

**Bubble**:
The sphere drawn at a photo's pose in the 3D scene.
_Avoid_: marker, point, pin

**Camera Frustum**:
The line-drawn pyramid attached to a bubble that shows the heading the photo
was taken along.
_Avoid_: arrow, cone, gizmo

**Footprint**:
The two-dimensional outline of a building, as mapped in real-world data.
_Avoid_: polygon, outline

**Building**:
A real-world structure in the uploaded area, derived from source map data
rather than from the photos. Buildings are context, not content — they exist
to make photo poses readable.
_Avoid_: model, mesh, object

**Building Layer**:
The whole set of Buildings for the current upload, taken together and shown or
hidden as one. It is decoration: it never blocks, delays, or fails an upload.
_Avoid_: buildings, geometry, overlay

**Building Height**:
The true-metre height of a building's top above the ground beside it, as
recorded in source map data. Deliberately distinct from a photo's Altitude,
which is metres above sea level in Scene Space.
_Avoid_: elevation, altitude, roof height

**Terrain Elevation**:
The height of the ground above sea level at a location, read from an external
terrain model. Used to sit buildings on the land, and never exposed as a
photo-relative measurement.
_Avoid_: ground height, DEM, elevation

**Altitude**:
A photo's height above sea level, as read from its EXIF. Not the same as
Terrain Elevation (the ground below it) or Building Height (the structure
beside it).
_Avoid_: elevation, height, Z
