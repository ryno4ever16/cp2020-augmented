/**
 * area-geometry.js
 *
 * Pure geometry helpers for FoundryVTT v14 Scene Region shapes.
 * No Foundry imports, no DOM, no network.
 *
 * Coordinate convention: SCREEN space. y increases DOWNWARD.
 * Angles in DEGREES: 0° = east (+x), increases CLOCKWISE.
 *   x = ox + r * cos(θ * π/180)
 *   y = oy + r * sin(θ * π/180)
 * This matches Math.atan2(py - oy, px - ox) in screen space.
 */

/**
 * Build a Region ellipse-shape descriptor (circle).
 *
 * @param {number} cx       Centre x (px)
 * @param {number} cy       Centre y (px)
 * @param {number} radiusPx Radius in pixels
 * @returns {{ type: "ellipse", x: number, y: number, radiusX: number, radiusY: number, rotation: number, hole: boolean }}
 */
export function circleEllipseShape(cx, cy, radiusPx) {
  return {
    type: "ellipse",
    x: cx,
    y: cy,
    radiusX: radiusPx,
    radiusY: radiusPx,
    rotation: 0,
    hole: false,
  };
}

/**
 * Compute a flat polygon point array for a cone (pie-slice) shape.
 *
 * The polygon has:
 *   - Vertex 0: apex at (ox, oy)
 *   - Vertices 1 … segments+1: arc points from (dirDeg - halfAngleDeg)
 *     to (dirDeg + halfAngleDeg), each at distance rangePx from the apex.
 *
 * Total vertices: segments + 2  →  total flat numbers: 2 * (segments + 2).
 *
 * @param {number} ox           Apex x (px)
 * @param {number} oy           Apex y (px)
 * @param {number} dirDeg       Direction the cone faces (degrees, screen-space)
 * @param {number} halfAngleDeg Half the cone's total angle (degrees)
 * @param {number} rangePx      Radius / range of the cone (px)
 * @param {number} [segments=12] Number of arc subdivisions
 * @returns {number[]} Flat [x0,y0, x1,y1, …] array
 */
export function conePolygonPoints(ox, oy, dirDeg, halfAngleDeg, rangePx, segments = 12) {
  const pts = [ox, oy]; // apex

  const startDeg = dirDeg - halfAngleDeg;
  const endDeg   = dirDeg + halfAngleDeg;

  for (let i = 0; i <= segments; i++) {
    const t   = i / segments; // 0 … 1
    const deg = startDeg + t * (endDeg - startDeg);
    const rad = deg * (Math.PI / 180);
    pts.push(ox + rangePx * Math.cos(rad), oy + rangePx * Math.sin(rad));
  }

  return pts; // length = 2 * (segments + 2)
}

/**
 * Compute a flat polygon point array for a ray (rectangle strip) shape.
 *
 * The rectangle starts at (ox, oy), extends lengthPx along dirDeg,
 * and is widthPx wide (widthPx/2 perpendicular to each side).
 *
 * Perpendicular-left = dirDeg + 90° (screen-space CW).
 *
 * Corners in order: near-left, far-left, far-right, near-right.
 *   near-left  = (ox, oy) + halfWidth along perp
 *   far-left   = near-left + lengthPx along dir
 *   far-right  = (ox, oy) - halfWidth along perp + lengthPx along dir
 *   near-right = (ox, oy) - halfWidth along perp
 *
 * @param {number} ox       Origin x (px)
 * @param {number} oy       Origin y (px)
 * @param {number} dirDeg   Direction of the ray (degrees, screen-space)
 * @param {number} lengthPx Length of the strip (px)
 * @param {number} widthPx  Total width of the strip (px)
 * @returns {number[]} Flat [x0,y0, x1,y1, x2,y2, x3,y3] array (8 numbers)
 */
export function rayPolygonPoints(ox, oy, dirDeg, lengthPx, widthPx) {
  const halfW  = widthPx / 2;
  const dirRad = dirDeg * (Math.PI / 180);
  const perpRad = (dirDeg + 90) * (Math.PI / 180);

  // Unit vectors
  const dx = Math.cos(dirRad);
  const dy = Math.sin(dirRad);
  const px = Math.cos(perpRad);
  const py = Math.sin(perpRad);

  // Corners
  const nlx = ox + halfW * px;
  const nly = oy + halfW * py;

  const flx = nlx + lengthPx * dx;
  const fly = nly + lengthPx * dy;

  const frx = ox - halfW * px + lengthPx * dx;
  const fry = oy - halfW * py + lengthPx * dy;

  const nrx = ox - halfW * px;
  const nry = oy - halfW * py;

  return [nlx, nly, flx, fly, frx, fry, nrx, nry];
}

/**
 * Build a Region polygon-shape descriptor for a cone.
 *
 * @param {number} ox
 * @param {number} oy
 * @param {number} dirDeg
 * @param {number} halfAngleDeg
 * @param {number} rangePx
 * @param {number} [segments=12]
 * @returns {{ type: "polygon", points: number[], hole: boolean }}
 */
export function conePolygonShape(ox, oy, dirDeg, halfAngleDeg, rangePx, segments = 12) {
  return {
    type: "polygon",
    points: conePolygonPoints(ox, oy, dirDeg, halfAngleDeg, rangePx, segments),
    hole: false,
  };
}

/**
 * Build a Region polygon-shape descriptor for a ray (rectangle strip).
 *
 * @param {number} ox
 * @param {number} oy
 * @param {number} dirDeg
 * @param {number} lengthPx
 * @param {number} widthPx
 * @returns {{ type: "polygon", points: number[], hole: boolean }}
 */
export function rayPolygonShape(ox, oy, dirDeg, lengthPx, widthPx) {
  return {
    type: "polygon",
    points: rayPolygonPoints(ox, oy, dirDeg, lengthPx, widthPx),
    hole: false,
  };
}

/**
 * Ray-casting point-in-polygon test on a flat [x0,y0,x1,y1,...] array.
 *
 * Uses the standard horizontal-ray algorithm: count how many polygon edges
 * cross the horizontal ray from (px, py) towards +x.  An odd count means
 * the point is inside.
 *
 * @param {number}   px         Test point x
 * @param {number}   py         Test point y
 * @param {number[]} flatPoints Flat polygon vertex array [x0,y0,x1,y1,...]
 * @returns {boolean}
 */
export function pointInPolygon(px, py, flatPoints) {
  const n = flatPoints.length / 2; // number of vertices
  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flatPoints[2 * i];
    const yi = flatPoints[2 * i + 1];
    const xj = flatPoints[2 * j];
    const yj = flatPoints[2 * j + 1];

    // Does edge (j→i) cross the horizontal ray from (px, py)?
    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
}
