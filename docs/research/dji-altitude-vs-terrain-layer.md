# DJI photo altitude vs. the terrain layer

Research note for the vertical-datum relationship between the altitude DJI
writes into a photo's EXIF and the Copernicus DEM the app draws its ground
from. Companion to ADR-0006 and ADR-0007.

## What DJI records

DJI writes two altitudes into a photo, in two different frames:

| Field | Where | Meaning | Frame |
| --- | --- | --- | --- |
| `AbsoluteAltitude` | XMP `drone-dji` namespace, **copied into EXIF `GPSAltitude`** | DJI's "absolute" height | WGS84 **ellipsoidal** on RTK/Enterprise; a barometric estimate on consumer drones |
| `RelativeAltitude` | XMP `drone-dji` namespace only | Height above the takeoff point | Relative to home point (not AGL, not MSL) |

So the value this app reads — EXIF `GPSAltitude` via exif-js — is DJI's
*absolute* altitude, not the takeoff-relative one. That is the important
finding: the app is not reading a relative height by accident.

`GPSAltitudeRef` is always `0` ("above sea level") for DJI and is **not** a
reliable datum indicator. It carries the sign convention only; it does not
mean the number is orthometric.

Sources:

- DJI Onboard SDK, *Flight Altitude*: GPS Altitude is "real-time earth
  ellipsoid height based on GPS", 0 point = WGS84 —
  <https://developer.dji.com/onboard-sdk/documentation/guides/component-guide-altitude.html>
- DJI Terra Help: elevation from WGS84/CGCS2000 data "is the ellipsoid
  height" — <https://support.dji.com/help/content?customId=en-us03400005219>
- Agisoft Metashape KB: "AbsoluteAltitude and RelativeAltitude (the latter
  defines the height above the take-off point). To the image EXIF the
  AbsoluteAltitude value is written." —
  <https://agisoft.freshdesk.com/support/solutions/articles/31000152491>
- exiftool DJI tag list — <https://exiftool.org/TagNames/DJI.html>

### Known uncertainty

Community and photogrammetry tooling report that on consumer (non-RTK) drones
DJI's "absolute" altitude behaves like a **barometric** figure that drifts
with weather and can be off by hundreds of feet, rather than a clean GPS
ellipsoidal height. Some sources call it outright unreliable. DJI has not
published a per-model matrix, so the frame varies by model and firmware.

- MatricePilots — <https://matricepilots.com/threads/m4t-incorrect-altitude-in-photo-properties.26003/>
- MavicPilots — <https://mavicpilots.com/threads/altitude-above-sea-level-during-flight.147682/>
- Esri Drone2Map thread — <https://community.esri.com/t5/arcgis-drone2map-questions/drone2map-how-to-adjust-image-altitude-in-exif/td-p/272941>

## What the terrain layer uses

The app's ground source is the Open-Meteo elevation API, which serves the
**Copernicus DEM (GLO-90)**. Copernicus DEM is referenced to the **EGM2008
geoid** — that is, it is **orthometric** height (height above mean sea level).

## The relationship

Ellipsoidal height `h` and orthometric height `H` differ by the geoid
undulation `N` at that location:

```
H = h − N        (h: ellipsoidal, H: MSL/orthometric, N: EGM2008 undulation)
```

So when a photo's EXIF altitude (ellipsoidal, from DJI) is compared directly
against the DEM (orthometric), they disagree by `N` — which is **location
dependent and can exceed 100 m in magnitude**.

EGM2008 undulation at sample sites (via GeographicLib GeoidEval):

| Site | EGM2008 `N` (m) | Sign of the error if EXIF is read as MSL |
| --- | --- | --- |
| London (51.50 N, 0.12 W) | +46.08 | photo reads ~46 m too high |
| Paris (48.86 N, 2.35 E) | +44.61 | ~45 m too high |
| Denver (39.74 N, 104.99 W) | −17.28 | ~17 m too low |
| Lima / Quito region (0.18 S, 78.47 W) | +26.76 | ~27 m too high |
| Singapore (1.35 N, 103.82 E) | +8.03 | ~8 m too high |
| Tokyo (35.68 N, 139.65 E) | +36.78 | ~37 m too high |
| San Francisco (37.77 N, 122.42 W) | −32.16 | ~32 m too low |
| Reykjavik (64.15 N, 21.94 W) | +66.48 | ~66 m too high |

Geoid calculator: <https://geographiclib.sourceforge.io/cgi-bin/GeoidEval>

## What this means for the app

1. **The terrain lookup is unaffected.** Buildings are placed against the DEM
   in the DEM's own frame, and the Ground Reference (ADR-0006) cancels any
   common vertical offset. There is no cross-datum comparison in the building
   path, so this does not threaten ADR-0006 or ADR-0007.

2. **Photo bubbles are the exposed surface.** Bubbles are placed at raw EXIF
   altitude (`y: alt`) and the ground plane/tiles sit at `y = 0`. If DJI's
   value is ellipsoidal and the site's geoid undulation `N` is large, the
   bubble's height above the map plane is off by `N` — tens of metres in
   London, over 100 m at the extremes.

3. **Do not silently convert.** ADR-0003 already refuses to derive
   photo-relative height figures because the EXIF datum is untrustworthy. The
   same reasoning blocks applying a geoid correction based on an assumed
   ellipsoidal frame: on consumer drones the value may be barometric instead,
   so `H = h − N` could make the error *worse*. A conversion would also
   require shipping an EGM2008 grid or a network geoid lookup — a new
   dependency and a new failure mode for the app's decorative layer.

4. **The honest options**, in order of preference:
   - Leave bubbles at raw EXIF altitude, document that heights are in the
     camera's own datum and not directly comparable to the ground (current
     behaviour; consistent with ADR-0003).
   - If a correction is ever wanted, make it explicit and opt-in, and prefer
     `drone-dji:RelativeAltitude` + the takeoff's DEM elevation for consumer
     drones, rather than a blind geoid shift.
   - Do not attempt to auto-detect the datum from the file: `GPSAltitudeRef`
     does not carry it.

## Open questions

- Does the app's EXIF path currently read only EXIF `GPSAltitude`, or can it
  reach the XMP `drone-dji` fields? exif-js does not parse XMP, so the
  relative-altitude field is currently invisible to the app — a prerequisite
  for any relative-altitude approach.
- Which DJI models does the target user actually shoot with? The correct
  treatment differs between RTK/Enterprise (ellipsoidal) and consumer
  (barometric), and the user's own files settle it better than any general
  rule.
