import * as THREE from 'three';

// ============================================
// 3D Vocal Tract Model
//
// Supports two view modes:
//   '3d'           — Full 3D anatomical model visible from all angles (default)
//   'crossSection' — Mid-sagittal clipping plane slices model in half
//
// In 3D mode, structures are built as volumetric geometry (swept profiles,
// half-pipes, tubes). In cross-section mode, the old extrusion + clip approach.
// ============================================

const DEPTH = 1.2;
const HALF  = DEPTH / 2;
const SKIN_DEPTH = 1.4;
const SKIN_HALF  = SKIN_DEPTH / 2;

// -------------------------------------------------------
// Helper: smooth CatmullRom curve from control points
// -------------------------------------------------------
function smoothCurveShape(points, closed = true) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(p => new THREE.Vector3(p.x, p.y, 0)),
    closed, 'catmullrom', 0.5
  );
  const pts = curve.getPoints(80);
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  if (closed) shape.closePath();
  return shape;
}

// -------------------------------------------------------
// Helper: extrude shape centered at z=0 (cross-section mode)
// -------------------------------------------------------
function makeExtruded(shape, material, depth = DEPTH) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2
  });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, material);
}

// -------------------------------------------------------
// Helper: build an arch / half-pipe BufferGeometry
// from a sagittal profile and a width function.
// Used for palate, velum, pharynx, nasal cavity, oral cavity.
//
//  sagittalPoints : [{x,y}, ...]   midline profile
//  widthFn(t)     : 0..1 → half-width at that fraction along the spine
//  options:
//    segments     — # spine samples (default 24)
//    arcSegments  — # radial samples in the half-pipe (default 10)
//    archHeight   — how tall the arch rises (default 0.08)
//    concave      — true = arch curves DOWNWARD (roof of mouth); false = upward
//    closed       — cap the ends (default false)
//    thickness    — if > 0, creates inner+outer shell for a thick wall
// -------------------------------------------------------
function buildArchFromProfile(sagittalPoints, widthFn, options = {}) {
  const {
    segments    = 24,
    arcSegments = 10,
    archHeight  = 0.08,
    concave     = true,
    thickness   = 0,
  } = options;

  const spine = new THREE.CatmullRomCurve3(
    sagittalPoints.map(p => new THREE.Vector3(p.x, p.y, 0)),
    false, 'catmullrom', 0.5
  );
  const spinePoints = spine.getPoints(segments);

  const verts  = [];
  const idx    = [];
  const dir    = concave ? -1 : 1;

  // Single shell
  const buildShell = (ySign, startIdx) => {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const w = widthFn(t);
      const p = spinePoints[i];
      for (let j = 0; j <= arcSegments; j++) {
        const a = (j / arcSegments) * Math.PI;
        const z = Math.cos(a) * w;
        const yOff = dir * ySign * Math.sin(a) * archHeight;
        verts.push(p.x, p.y + yOff, z);
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < arcSegments; j++) {
        const a = startIdx + i * (arcSegments + 1) + j;
        const b = a + arcSegments + 1;
        idx.push(a, b, a + 1);
        idx.push(a + 1, b, b + 1);
      }
    }
  };

  if (thickness > 0) {
    // Outer shell
    buildShell(1, 0);
    const outerCount = (segments + 1) * (arcSegments + 1);
    // Inner shell (slightly smaller)
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const w = widthFn(t) - thickness * 0.3;
      const p = spinePoints[i];
      for (let j = 0; j <= arcSegments; j++) {
        const a = (j / arcSegments) * Math.PI;
        const z = Math.cos(a) * Math.max(0.01, w);
        const yOff = dir * Math.sin(a) * Math.max(0.01, archHeight - thickness);
        verts.push(p.x, p.y + yOff, z);
      }
    }
    // Inner shell faces (flipped winding)
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < arcSegments; j++) {
        const a = outerCount + i * (arcSegments + 1) + j;
        const b = a + arcSegments + 1;
        idx.push(a, a + 1, b);
        idx.push(a + 1, b + 1, b);
      }
    }
    // Connect edges
    for (let i = 0; i <= segments; i++) {
      const oBase = i * (arcSegments + 1);
      const iBase = outerCount + i * (arcSegments + 1);
      // Left edge
      if (i < segments) {
        const oNext = (i + 1) * (arcSegments + 1);
        const iNext = outerCount + (i + 1) * (arcSegments + 1);
        idx.push(oBase, iBase, oNext);
        idx.push(oNext, iBase, iNext);
        // Right edge
        const oR = oBase + arcSegments;
        const iR = iBase + arcSegments;
        const oRn = oNext + arcSegments;
        const iRn = iNext + arcSegments;
        idx.push(oR, oRn, iR);
        idx.push(oRn, iRn, iR);
      }
    }
  } else {
    buildShell(1, 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// -------------------------------------------------------
// Helper: build a 3D tongue from sagittal profile points
// by sweeping elliptical cross-sections along the midline.
//
// Uses a MANUAL frame (not Frenet) because the spine is planar
// (all points in the XY plane with z=0). Frenet frames produce
// unstable flipping normals for planar curves, causing the
// tongue to twist into a zigzag "Z" shape.
//
// Manual frame:
//   tangent = direction along the spine in XY
//   up      = perpendicular to tangent in XY plane (rotated 90° CCW)
//   side    = always (0, 0, 1) — the z-axis
// -------------------------------------------------------
function buildTongue3DGeometry(upperContour, lowerContour) {
  // upperContour: [{x,y}, ...] root→tip (smooth upper surface)
  // lowerContour: [{x,y}, ...] root→tip (smooth under-surface)
  // Both are already smoothly interpolated via CatmullRom to the same count.
  // IMPORTANT: The contours must already be clamped to stay below the palate
  // with sufficient margin (archHeight + clearance). This function does NO
  // palate clamping — it only builds smooth geometry from the contours.

  const N = upperContour.length; // same length guaranteed

  // Build spine from midpoints, half-heights from distance
  const spinePoints = [];
  const halfHeights = [];
  for (let i = 0; i < N; i++) {
    const u = upperContour[i];
    const l = lowerContour[i];
    spinePoints.push({ x: (u.x + l.x) / 2, y: (u.y + l.y) / 2 });
    halfHeights.push(Math.max(0.015, Math.abs(u.y - l.y) / 2));
  }

  // Smooth half-heights to prevent sudden thickness changes that create
  // visible ridges on the 3D surface. 3-point moving average, 2 passes.
  for (let pass = 0; pass < 2; pass++) {
    const smoothed = halfHeights.slice();
    for (let i = 1; i < smoothed.length - 1; i++) {
      smoothed[i] = (halfHeights[i - 1] + halfHeights[i] * 2 + halfHeights[i + 1]) / 4;
    }
    for (let i = 0; i < halfHeights.length; i++) halfHeights[i] = smoothed[i];
  }

  // Smooth spine with CatmullRom
  const spine = new THREE.CatmullRomCurve3(
    spinePoints.map(p => new THREE.Vector3(p.x, p.y, 0)),
    false, 'catmullrom', 0.4
  );

  const SEGS = 48;      // along spine — higher count for smoother surface
  const RAD  = 16;       // radial segments around cross-section
  const pts  = spine.getPoints(SEGS);

  // Interpolate half-heights along spine
  function getHalfH(t) {
    const fi = t * (halfHeights.length - 1);
    const lo = Math.floor(fi);
    const hi = Math.min(lo + 1, halfHeights.length - 1);
    const f  = fi - lo;
    return halfHeights[lo] * (1 - f) + halfHeights[hi] * f;
  }

  // Width profile: narrow at tip and root, widest at body
  // Asymmetric: slightly wider behind center, tapering to thin tip
  function getHalfW(t) {
    const bodyT = Math.sin(t * Math.PI);
    const tipTaper = 1 - Math.pow(t, 1.8) * 0.35;  // less aggressive taper — rounder tip
    const rootTaper = Math.min(1, t * 2.5);           // slightly slower root taper
    return 0.05 + 0.28 * bodyT * tipTaper * rootTaper; // wider minimum (0.05 vs 0.04)
  }

  const verts   = [];
  const indices = [];

  for (let i = 0; i <= SEGS; i++) {
    const t  = i / SEGS;
    const p  = pts[i];
    const hh = getHalfH(t);
    const hw = getHalfW(t);

    // Manual tangent from finite differences
    let tx, ty;
    if (i === 0) {
      tx = pts[1].x - pts[0].x;
      ty = pts[1].y - pts[0].y;
    } else if (i === SEGS) {
      tx = pts[SEGS].x - pts[SEGS - 1].x;
      ty = pts[SEGS].y - pts[SEGS - 1].y;
    } else {
      tx = pts[i + 1].x - pts[i - 1].x;
      ty = pts[i + 1].y - pts[i - 1].y;
    }
    const tLen = Math.sqrt(tx * tx + ty * ty) || 1;
    tx /= tLen;
    ty /= tLen;

    // "Up" = perpendicular to tangent in XY plane (rotate 90° CCW)
    const upX = -ty;
    const upY = tx;

    // NO per-vertex palate clamping. The upper contour was already clamped
    // with a gap >= archHeight + clearance, so the 3D mesh naturally stays
    // below the palate at all z positions. This keeps cross-sections as
    // smooth ellipses — no dents, creases, or folds.

    for (let j = 0; j <= RAD; j++) {
      const angle = (j / RAD) * Math.PI * 2;
      const cosA  = Math.cos(angle);
      const sinA  = Math.sin(angle);

      // Slightly flatten the bottom of the tongue (more natural shape)
      // Use smooth transition instead of hard cutoff at sinA=0
      let hhAdj = hh;
      if (sinA < 0) {
        const blend = Math.min(1, -sinA); // 0 at equator, 1 at bottom
        hhAdj *= (1 - blend * 0.15);      // gradual flatten to 85% at bottom
      }

      const dyScale = sinA * hhAdj;
      const dz      = cosA * hw;

      const vx = p.x + upX * dyScale;
      const vy = p.y + upY * dyScale;

      verts.push(vx, vy, dz);
    }
  }

  // Triangle strip indices connecting adjacent rings
  for (let i = 0; i < SEGS; i++) {
    for (let j = 0; j < RAD; j++) {
      const a = i * (RAD + 1) + j;
      const b = a + RAD + 1;
      indices.push(a, b, a + 1);
      indices.push(a + 1, b, b + 1);
    }
  }

  // Cap at root end (i=0) — fan from center point
  const rootCenter = verts.length / 3;
  verts.push(pts[0].x, pts[0].y, 0);
  for (let j = 0; j < RAD; j++) {
    indices.push(rootCenter, j + 1, j);
  }

  // Cap at tip end (i=SEGS) — fan from center point
  const tipCenter = verts.length / 3;
  verts.push(pts[SEGS].x, pts[SEGS].y, 0);
  const tipBase = SEGS * (RAD + 1);
  for (let j = 0; j < RAD; j++) {
    indices.push(tipCenter, tipBase + j, tipBase + j + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// -------------------------------------------------------
// Helper: resample a CatmullRom curve from control points
// to N evenly-spaced points. Used to match upper and lower
// tongue contours to the same count for smooth geometry.
// -------------------------------------------------------
function resampleContour(controlPoints, N) {
  const curve = new THREE.CatmullRomCurve3(
    controlPoints.map(p => new THREE.Vector3(p.x, p.y, 0)),
    false, 'catmullrom', 0.4
  );
  const pts = curve.getPoints(N - 1);
  return pts.map(p => ({ x: p.x, y: p.y }));
}

// -------------------------------------------------------
// Helper: build 3D lip as a half-torus tube
//   center : {x, y} — center of the mouth opening in the sagittal plane
//   halfW  : half-width of the mouth opening (z)
//   halfH  : half-height of the mouth opening (y)
//   radius : tube radius (lip thickness)
//   upper  : true for upper lip, false for lower
// -------------------------------------------------------
function buildLipTube(center, halfW, halfH, radius, upper, protrusion = 0) {
  const tubeSeg = 16;
  const radSeg  = 8;

  // Path: half ellipse in the yz plane (from one corner to the other)
  const pathPts = [];
  const startA = upper ? 0 : Math.PI;
  const endA   = upper ? Math.PI : Math.PI * 2;
  for (let i = 0; i <= tubeSeg; i++) {
    const a = startA + (endA - startA) * (i / tubeSeg);
    const z = Math.cos(a) * halfW;
    const y = center.y + Math.sin(a) * halfH;
    // protrusion tapers: strongest at center (i=tubeSeg/2), zero at corners
    const pFactor = Math.sin((i / tubeSeg) * Math.PI);
    const x = center.x + protrusion * pFactor;
    pathPts.push(new THREE.Vector3(x, y, z));
  }

  const path = new THREE.CatmullRomCurve3(pathPts, false, 'catmullrom', 0.5);
  const geo  = new THREE.TubeGeometry(path, tubeSeg, radius, radSeg, false);
  return geo;
}


// =====================================================
// VocalTract class
// =====================================================
export default class VocalTract {
  constructor(scene, clippingPlanes = []) {
    this.scene = scene;
    this.clippingPlanes = clippingPlanes;
    this.viewMode = '3d';  // '3d' | 'crossSection'

    this.group = new THREE.Group();
    scene.add(this.group);

    this.meshes = {};
    this.skinVisible = false;
    this.voicingActive = false;
    this.voicingTime = 0;

    // Tongue state — positioned to fill the oral cavity naturally.
    // Teeth are at ~x=1.10, palate peaks at ~y=0.72
    // Tongue body neutral sits around x=0.15, y=0.18 (mid-low, central)
    this.neutralTongue = {
      tip:   { x: 0.80,  y: 0.22 },
      blade: { x: 0.58,  y: 0.18 },
      front: { x: 0.35,  y: 0.22 },
      body:  { x: 0.05,  y: 0.18 },
      root:  { x: -0.46, y: -0.23 }  // slightly more posterior (was -0.40, -0.20)
    };
    this.currentTongue = JSON.parse(JSON.stringify(this.neutralTongue));

    // Lip state
    this.neutralLips = { rounding: 0, openness: 0.3, protrusion: 0, spread: 0 };
    this.currentLips = { ...this.neutralLips };

    // Velum / jaw state
    this.neutralVelumHeight = 1.0;
    this.currentVelumHeight = 1.0;
    this.neutralJawOpen = 0.2;
    this.currentJawOpen = 0.2;

    // Skin group (never clipped)
    this.skinGroup = new THREE.Group();
    this.group.add(this.skinGroup);

    // 3D-specific mesh references for cleanup
    this._3dMeshes = [];

    this._buildAll();
  }

  // =====================
  // BUILD ALL
  // =====================
  _buildAll() {
    this._buildSkin();
    this._buildSkull();
    this._buildNasalCavity();
    this._buildHardPalate();
    this._buildAlveolarRidge();
    this._buildVelum();
    this._buildPharynx();
    this._buildEpiglottis();
    this._buildLarynx();
    this._buildOralCavity();
    this._buildTongue();
    this._buildJaw();
    this._buildUpperTeeth();
    this._buildLowerTeeth();
    this._buildUpperLip();
    this._buildLowerLip();
    this._buildTrachea();

    if (this.viewMode === 'crossSection' && this.clippingPlanes.length > 0) {
      this._applyClipping();
    }

    // Hide skin by default (no toggle button — articulators must be visible)
    this.skinGroup.visible = this.skinVisible;
  }

  // =====================
  // CLIPPING (cross-section mode only)
  // =====================
  _applyClipping() {
    this.group.traverse((child) => {
      if (child.isMesh && child.material) {
        let isSkin = false;
        this.skinGroup.traverse((sc) => { if (sc === child) isSkin = true; });
        if (!isSkin) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => {
            m.clippingPlanes = this.clippingPlanes;
            m.clipShadows = true;
            m.needsUpdate = true;
          });
        }
      }
    });
  }

  _removeClipping() {
    this.group.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => {
          m.clippingPlanes = [];
          m.clipShadows = false;
          m.needsUpdate = true;
        });
      }
    });
  }

  // =====================
  // VIEW MODE TOGGLE
  // =====================
  setViewMode(mode) {
    if (mode === this.viewMode) return;
    this.viewMode = mode;

    // Clean up all meshes and rebuild
    this._disposeAll();
    this._buildAll();

    // Restore current articulator positions
    this._rebuildTongueMesh();
    this.setLipShape(this.currentLips);
  }

  _disposeAll() {
    // Dispose all geometries/materials
    const toRemove = [];
    this.group.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material?.dispose();
        }
        toRemove.push(child);
      }
    });
    // Remove from parents
    toRemove.forEach(m => m.parent?.remove(m));

    // Reset mesh references
    this.meshes = {};
    this.tongueMesh = null;
    this.upperLipMesh = null;
    this.lowerLipMesh = null;
    this.vocalFold1 = null;
    this.vocalFold2 = null;

    // Re-create groups
    this.group.remove(this.skinGroup);
    this.skinGroup = new THREE.Group();
    this.group.add(this.skinGroup);

    if (this.velumGroup) {
      this.group.remove(this.velumGroup);
      this.velumGroup = null;
    }
    if (this.jawGroup) {
      this.group.remove(this.jawGroup);
      this.jawGroup = null;
    }
    if (this.larynxGroup) {
      this.group.remove(this.larynxGroup);
      this.larynxGroup = null;
    }
  }

  // =====================
  // IS 3D MODE?
  // =====================
  get is3D() { return this.viewMode === '3d'; }

  // ========================================
  // ========== SKIN ==========
  // ========================================
  _buildSkin() {
    const skinPts = [
      { x: 1.65, y: 0.52 }, { x: 1.75, y: 0.20 }, { x: 1.60, y: -0.15 },
      { x: 1.05, y: -0.65 }, { x: 0.25, y: -1.05 }, { x: -0.50, y: -1.15 },
      { x: -1.20, y: -0.95 }, { x: -1.60, y: -0.30 }, { x: -1.75, y: 0.50 },
      { x: -1.70, y: 1.30 }, { x: -1.40, y: 2.00 }, { x: -0.50, y: 2.35 },
      { x: 0.40, y: 2.25 }, { x: 1.00, y: 1.95 }, { x: 1.25, y: 1.65 },
      { x: 1.40, y: 1.45 }, { x: 1.50, y: 1.30 }, { x: 1.45, y: 1.15 },
      { x: 1.58, y: 1.00 }, { x: 1.65, y: 0.80 },
    ];
    const shape = smoothCurveShape(skinPts, true);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd4b096, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: true, roughness: 0.7,
    });
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: SKIN_DEPTH, bevelEnabled: true,
      bevelThickness: 0.25, bevelSize: 0.25, bevelSegments: 8,
    });
    geo.translate(0, 0, -SKIN_HALF);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;
    this.skinGroup.add(mesh);
    this.meshes.skin = mesh;

    // Nose
    const noseGeo = new THREE.SphereGeometry(0.16, 16, 12);
    const noseMat = new THREE.MeshStandardMaterial({
      color: 0xd4b096, transparent: true, opacity: 0.55, roughness: 0.7
    });
    const nose = new THREE.Mesh(noseGeo, noseMat);
    nose.position.set(1.52, 1.25, 0);
    nose.scale.set(0.8, 1.0, 1.3);
    this.skinGroup.add(nose);

    // Chin
    const chinGeo = new THREE.SphereGeometry(0.18, 12, 8);
    const chin = new THREE.Mesh(chinGeo, noseMat.clone());
    chin.position.set(1.72, 0.15, 0);
    chin.scale.set(0.7, 0.8, 1.2);
    this.skinGroup.add(chin);

    // Ears
    const earGeo = new THREE.SphereGeometry(0.22, 8, 8);
    const earMat = new THREE.MeshStandardMaterial({
      color: 0xc8a88c, transparent: true, opacity: 0.45, roughness: 0.8
    });
    const earR = new THREE.Mesh(earGeo, earMat);
    earR.position.set(-0.2, 0.9, SKIN_HALF + 0.15);
    earR.scale.set(0.4, 1.0, 0.5);
    this.skinGroup.add(earR);
    const earL = earR.clone();
    earL.position.z = -(SKIN_HALF + 0.15);
    this.skinGroup.add(earL);
  }

  // ========================================
  // ========== SKULL ==========
  // ========================================
  _buildSkull() {
    const pts = [
      { x: 1.50, y: 0.55 }, { x: 1.55, y: 0.32 }, { x: 1.40, y: -0.02 },
      { x: 0.90, y: -0.48 }, { x: 0.30, y: -0.65 }, { x: -0.50, y: -0.62 },
      { x: -1.20, y: -0.30 }, { x: -1.45, y: 0.30 }, { x: -1.40, y: 1.20 },
      { x: -1.10, y: 1.85 }, { x: -0.30, y: 2.10 }, { x: 0.50, y: 2.00 },
      { x: 1.00, y: 1.70 }, { x: 1.20, y: 1.40 }, { x: 1.30, y: 1.18 },
      { x: 1.32, y: 1.02 }, { x: 1.48, y: 0.82 },
    ];
    const shape = smoothCurveShape(pts, true);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xe8ddd0, transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthWrite: false, roughness: 0.9
    });
    const mesh = makeExtruded(shape, mat, DEPTH * 0.8);
    mesh.renderOrder = -5;
    this.group.add(mesh);
    this.meshes.skull = mesh;
  }

  // ========================================
  // ========== NASAL CAVITY ==========
  // ========================================
  _buildNasalCavity() {
    if (this.is3D) {
      // In 3D mode, nasal cavity is a subtle dark passage above the palate
      const midline = [
        { x: 1.15, y: 0.98 }, { x: 0.80, y: 1.00 }, { x: 0.35, y: 0.96 },
        { x: -0.1, y: 0.88 }, { x: -0.45, y: 0.82 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.5 * (0.6 + 0.4 * Math.sin(t * Math.PI)),
        { segments: 14, arcSegments: 6, archHeight: 0.10, concave: false }
      );
      const mat = new THREE.MeshStandardMaterial({
        color: 0x4a2020, side: THREE.DoubleSide, roughness: 0.95,
        transparent: true, opacity: 0.4
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = -2;
      this.group.add(mesh);
      this.meshes.nasalCavity = mesh;
    } else {
      const pts = [
        { x: 1.15, y: 1.08 }, { x: 0.80, y: 1.14 }, { x: 0.35, y: 1.10 },
        { x: -0.1, y: 1.02 }, { x: -0.45, y: 0.88 }, { x: -0.45, y: 0.76 },
        { x: -0.1, y: 0.74 }, { x: 0.35, y: 0.80 }, { x: 0.80, y: 0.85 },
        { x: 1.15, y: 0.90 },
      ];
      const shape = smoothCurveShape(pts, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x351818, side: THREE.DoubleSide, roughness: 0.95
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.9);
      this.group.add(mesh);
      this.meshes.nasalCavity = mesh;
    }
  }

  // ========================================
  // ========== HARD PALATE ==========
  // ========================================
  _buildHardPalate() {
    if (this.is3D) {
      // Concave arch — roof of the mouth
      // Spans from behind alveolar ridge (~x=0.95) back to velum junction (~x=-0.08)
      const midline = [
        { x: 0.95, y: 0.64 }, { x: 0.70, y: 0.70 }, { x: 0.40, y: 0.68 },
        { x: 0.15, y: 0.65 }, { x: -0.08, y: 0.60 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.62 * (0.6 + 0.4 * Math.sin(t * Math.PI)),
        { segments: 20, arcSegments: 10, archHeight: 0.12, concave: true, thickness: 0.04 }
      );
      const mat = new THREE.MeshStandardMaterial({
        color: 0xd4a0a0, side: THREE.DoubleSide, roughness: 0.8
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = 0.01;
      this.group.add(mesh);
      this.meshes.hardPalate = mesh;
    } else {
      const pts = [
        { x: 0.95, y: 0.70 }, { x: 0.70, y: 0.76 }, { x: 0.40, y: 0.74 },
        { x: 0.15, y: 0.70 }, { x: -0.08, y: 0.63 }, { x: -0.08, y: 0.55 },
        { x: 0.15, y: 0.58 }, { x: 0.40, y: 0.60 }, { x: 0.70, y: 0.63 },
        { x: 0.95, y: 0.58 },
      ];
      const shape = smoothCurveShape(pts, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xd4a0a0, side: THREE.DoubleSide, roughness: 0.8
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.85);
      mesh.position.z = 0.01;
      this.group.add(mesh);
      this.meshes.hardPalate = mesh;
    }
  }

  // ========================================
  // ========== ALVEOLAR RIDGE ==========
  // ========================================
  _buildAlveolarRidge() {
    if (this.is3D) {
      // Small arch bump behind upper teeth — just behind x=1.10
      const midline = [
        { x: 1.08, y: 0.58 }, { x: 1.02, y: 0.68 }, { x: 0.95, y: 0.70 },
        { x: 0.88, y: 0.66 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.55 * (0.5 + 0.5 * Math.sin(t * Math.PI)),
        { segments: 12, arcSegments: 8, archHeight: 0.06, concave: true, thickness: 0.03 }
      );
      const mat = new THREE.MeshStandardMaterial({
        color: 0xdab0b0, side: THREE.DoubleSide, roughness: 0.7
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = 0.02;
      this.group.add(mesh);
      this.meshes.alveolarRidge = mesh;
    } else {
      const pts = [
        { x: 1.08, y: 0.58 }, { x: 1.02, y: 0.68 }, { x: 0.95, y: 0.70 },
        { x: 0.88, y: 0.66 }, { x: 0.95, y: 0.58 }, { x: 1.04, y: 0.52 },
      ];
      const shape = smoothCurveShape(pts, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xdab0b0, side: THREE.DoubleSide, roughness: 0.7
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.85);
      mesh.position.z = 0.02;
      this.group.add(mesh);
      this.meshes.alveolarRidge = mesh;
    }
  }

  // ========================================
  // ========== VELUM (SOFT PALATE) ==========
  // ========================================
  _buildVelum() {
    this.velumGroup = new THREE.Group();

    if (this.is3D) {
      // Thick arch that continues from the hard palate, curving down
      const midline = [
        { x: -0.08, y: 0.60 }, { x: -0.22, y: 0.57 }, { x: -0.38, y: 0.51 },
        { x: -0.48, y: 0.43 }, { x: -0.53, y: 0.35 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.55 * (1 - t * 0.4),
        { segments: 14, arcSegments: 8, archHeight: 0.08, concave: true, thickness: 0.05 }
      );
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc490b0, side: THREE.DoubleSide, roughness: 0.75
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.velumGroup.add(mesh);
      this.meshes.velum = mesh;

      // Uvula — small teardrop sphere
      const uvulaGeo = new THREE.SphereGeometry(0.05, 8, 8);
      const uvulaMat = new THREE.MeshStandardMaterial({
        color: 0xc490b0, roughness: 0.7
      });
      const uvula = new THREE.Mesh(uvulaGeo, uvulaMat);
      uvula.position.set(-0.53, 0.28, 0);
      uvula.scale.set(0.6, 1.4, 0.6);
      this.velumGroup.add(uvula);
      this.meshes.uvula = uvula;
    } else {
      const pts = [
        { x: -0.08, y: 0.65 }, { x: -0.22, y: 0.63 }, { x: -0.38, y: 0.58 },
        { x: -0.48, y: 0.50 }, { x: -0.54, y: 0.40 }, { x: -0.52, y: 0.30 },
        { x: -0.48, y: 0.36 }, { x: -0.42, y: 0.44 }, { x: -0.32, y: 0.47 },
        { x: -0.18, y: 0.50 }, { x: -0.08, y: 0.54 },
      ];
      const shape = smoothCurveShape(pts, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc490b0, side: THREE.DoubleSide, roughness: 0.75
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.8);
      this.velumGroup.add(mesh);
      this.meshes.velum = mesh;
      this.meshes.uvula = mesh;
    }

    this.group.add(this.velumGroup);
  }

  // ========================================
  // ========== PHARYNGEAL WALL ==========
  // ========================================
  _buildPharynx() {
    if (this.is3D) {
      // Half-cylinder tube — posterior throat wall
      const midline = [
        { x: -0.65, y: 0.85 }, { x: -0.72, y: 0.45 }, { x: -0.78, y: 0.0 },
        { x: -0.78, y: -0.45 }, { x: -0.72, y: -0.78 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.65,
        { segments: 16, arcSegments: 10, archHeight: 0.15, concave: false, thickness: 0.04 }
      );
      const mat = new THREE.MeshStandardMaterial({
        color: 0xb08080, side: THREE.DoubleSide, roughness: 0.85
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.meshes.pharynx = mesh;
    } else {
      const pts = [
        { x: -0.65, y: 0.85 }, { x: -0.72, y: 0.45 }, { x: -0.78, y: 0.0 },
        { x: -0.78, y: -0.45 }, { x: -0.72, y: -0.78 }, { x: -0.60, y: -0.78 },
        { x: -0.60, y: -0.45 }, { x: -0.60, y: 0.0 }, { x: -0.56, y: 0.45 },
        { x: -0.50, y: 0.85 },
      ];
      const shape = smoothCurveShape(pts, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xb08080, side: THREE.DoubleSide, roughness: 0.85
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.75);
      this.group.add(mesh);
      this.meshes.pharynx = mesh;
    }
  }

  // ========================================
  // ========== EPIGLOTTIS ==========
  // ========================================
  _buildEpiglottis() {
    if (this.is3D) {
      // Leaf-like shape using a scaled sphere
      const geo = new THREE.SphereGeometry(0.08, 10, 8);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc09090, roughness: 0.8
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(-0.20, -0.45, 0);
      mesh.scale.set(1.0, 1.5, 0.8);
      this.group.add(mesh);
      this.meshes.epiglottis = mesh;
    } else {
      const pts = [
        { x: -0.28, y: -0.42 }, { x: -0.18, y: -0.32 }, { x: -0.12, y: -0.48 },
        { x: -0.18, y: -0.58 }, { x: -0.28, y: -0.52 },
      ];
      const shape = smoothCurveShape(pts, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc09090, side: THREE.DoubleSide, roughness: 0.8
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.6);
      mesh.position.z = 0.02;
      this.group.add(mesh);
      this.meshes.epiglottis = mesh;
    }
  }

  // ========================================
  // ========== LARYNX / VOCAL FOLDS ==========
  // ========================================
  _buildLarynx() {
    this.larynxGroup = new THREE.Group();

    const foldDepth = this.is3D ? DEPTH * 0.6 : DEPTH * 0.5;
    const foldGeo = new THREE.BoxGeometry(0.28, 0.05, foldDepth);
    this.vocalFoldMat = new THREE.MeshStandardMaterial({
      color: 0x78909c, emissive: 0x000000, emissiveIntensity: 0
    });
    this.vocalFold1 = new THREE.Mesh(foldGeo, this.vocalFoldMat.clone());
    this.vocalFold1.position.set(-0.38, -0.73, 0);
    this.vocalFold1.rotation.z = 0.15;

    this.vocalFold2 = new THREE.Mesh(foldGeo.clone(), this.vocalFoldMat.clone());
    this.vocalFold2.position.set(-0.38, -0.82, 0);
    this.vocalFold2.rotation.z = -0.15;

    // Larynx housing
    if (this.is3D) {
      // Cylindrical housing
      const housingGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.35, 16, 1, true);
      const housingMat = new THREE.MeshStandardMaterial({
        color: 0x8a7070, transparent: true, opacity: 0.4,
        side: THREE.DoubleSide, roughness: 0.85
      });
      const housing = new THREE.Mesh(housingGeo, housingMat);
      housing.position.set(-0.38, -0.78, 0);
      housing.rotation.z = Math.PI / 2;
      this.larynxGroup.add(housing);
    } else {
      const housingPts = [
        { x: -0.12, y: -0.62 }, { x: -0.58, y: -0.62 }, { x: -0.65, y: -0.77 },
        { x: -0.58, y: -0.95 }, { x: -0.12, y: -0.95 }, { x: -0.08, y: -0.77 },
      ];
      const housingShape = new THREE.Shape();
      housingShape.moveTo(housingPts[0].x, housingPts[0].y);
      for (let i = 1; i < housingPts.length; i++) housingShape.lineTo(housingPts[i].x, housingPts[i].y);
      housingShape.closePath();
      const housingMat = new THREE.MeshStandardMaterial({
        color: 0x8a7070, transparent: true, opacity: 0.4,
        side: THREE.DoubleSide, depthWrite: false, roughness: 0.85
      });
      const housingMesh = makeExtruded(housingShape, housingMat, DEPTH * 0.6);
      this.larynxGroup.add(housingMesh);
    }

    this.larynxGroup.add(this.vocalFold1);
    this.larynxGroup.add(this.vocalFold2);
    this.group.add(this.larynxGroup);
    this.meshes.larynx = this.larynxGroup;
  }

  // ========================================
  // ========== TRACHEA ==========
  // ========================================
  _buildTrachea() {
    if (this.is3D) {
      // Cylinder tube
      const tracheaGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.55, 16, 1, true);
      const tracheaMat = new THREE.MeshStandardMaterial({
        color: 0x8a7070, side: THREE.DoubleSide, roughness: 0.85
      });
      const trachea = new THREE.Mesh(tracheaGeo, tracheaMat);
      trachea.position.set(-0.33, -1.22, 0);
      this.group.add(trachea);

      // Tracheal rings
      for (let i = 0; i < 3; i++) {
        const ringGeo = new THREE.TorusGeometry(0.19, 0.02, 6, 16);
        const ringMat = new THREE.MeshStandardMaterial({
          color: 0x9a8a7a, roughness: 0.8
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(-0.33, -1.05 - i * 0.15, 0);
        ring.rotation.x = Math.PI / 2;
        this.group.add(ring);
      }
    } else {
      const wallMat = new THREE.MeshStandardMaterial({
        color: 0x8a7070, side: THREE.DoubleSide, roughness: 0.85
      });
      const lShape = new THREE.Shape();
      lShape.moveTo(-0.54, -0.95); lShape.lineTo(-0.48, -0.95);
      lShape.lineTo(-0.50, -1.5); lShape.lineTo(-0.56, -1.5);
      lShape.closePath();
      this.group.add(makeExtruded(lShape, wallMat, DEPTH * 0.5));

      const rShape = new THREE.Shape();
      rShape.moveTo(-0.12, -0.95); rShape.lineTo(-0.18, -0.95);
      rShape.lineTo(-0.16, -1.5); rShape.lineTo(-0.10, -1.5);
      rShape.closePath();
      this.group.add(makeExtruded(rShape, wallMat.clone(), DEPTH * 0.5));

      for (let i = 0; i < 3; i++) {
        const y = -1.05 - i * 0.15;
        const ringShape = new THREE.Shape();
        ringShape.moveTo(-0.52, y); ringShape.lineTo(-0.14, y);
        ringShape.lineTo(-0.14, y - 0.03); ringShape.lineTo(-0.52, y - 0.03);
        ringShape.closePath();
        const ringMat = new THREE.MeshStandardMaterial({
          color: 0x9a8a7a, side: THREE.DoubleSide, roughness: 0.8
        });
        const ring = makeExtruded(ringShape, ringMat, DEPTH * 0.45);
        ring.position.z = 0.01;
        this.group.add(ring);
      }
    }
  }

  // ========================================
  // ========== ORAL CAVITY ==========
  // ========================================
  _buildOralCavity() {
    if (this.is3D) {
      // In 3D mode, skip the oral cavity entirely.
      this.meshes.oralCavity = null;
    } else {
      const pts = [
        { x: 1.10, y: 0.55 }, { x: 0.70, y: 0.62 }, { x: 0.35, y: 0.58 },
        { x: 0.05, y: 0.52 }, { x: -0.30, y: 0.42 }, { x: -0.48, y: 0.12 },
        { x: -0.48, y: -0.20 }, { x: -0.30, y: -0.20 }, { x: 0.05, y: -0.12 },
        { x: 0.35, y: -0.04 }, { x: 0.70, y: 0.00 }, { x: 1.10, y: 0.04 },
      ];
      const shape = smoothCurveShape(pts, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2a1515, side: THREE.DoubleSide, roughness: 0.95
      });
      const mesh = makeExtruded(shape, mat, DEPTH);
      mesh.renderOrder = -3;
      this.group.add(mesh);
      this.meshes.oralCavity = mesh;
    }
  }

  // ========================================
  // PALATE CEILING — returns the Y position of the palate/velum
  // underside at any x coordinate. Used for tongue clamping.
  //
  // The roof of the mouth profile (from MRI data):
  //   x ≈ 1.08 → alveolar ridge at y ≈ 0.58
  //   x ≈ 0.95 → anterior palate at y ≈ 0.64
  //   x ≈ 0.70 → palate peak at y ≈ 0.70
  //   x ≈ 0.40 → mid-palate at y ≈ 0.68
  //   x ≈ 0.15 → posterior palate at y ≈ 0.65
  //   x ≈ -0.08 → palate-velum junction at y ≈ 0.60
  //   x ≈ -0.30 → velum at y ≈ 0.54
  //   x ≈ -0.53 → uvula at y ≈ 0.35
  // ========================================
  _getPalateY(x) {
    // Piecewise linear interpolation of the palate underside
    // Profile matched to actual velum mesh underside positions
    // (velum 2D inner curve: -0.18→0.50, -0.32→0.47, -0.42→0.44, -0.48→0.36)
    const profile = [
      { x:  1.10, y: 0.55 },
      { x:  1.02, y: 0.62 },
      { x:  0.95, y: 0.64 },
      { x:  0.70, y: 0.70 },
      { x:  0.40, y: 0.68 },
      { x:  0.15, y: 0.65 },
      { x: -0.08, y: 0.58 },   // palate-velum junction — lowered from 0.60
      { x: -0.18, y: 0.52 },   // added: matches velum underside
      { x: -0.30, y: 0.47 },   // lowered from 0.54 to match velum mesh
      { x: -0.42, y: 0.40 },   // added: matches velum underside
      { x: -0.53, y: 0.32 },   // lowered from 0.35
      { x: -0.70, y: 0.20 },   // pharynx region - no palate constraint
    ];
    // Clamp x to profile range
    if (x >= profile[0].x) return profile[0].y;
    if (x <= profile[profile.length - 1].x) return profile[profile.length - 1].y;
    // Find surrounding points and interpolate
    for (let i = 0; i < profile.length - 1; i++) {
      if (x <= profile[i].x && x >= profile[i + 1].x) {
        const t = (x - profile[i + 1].x) / (profile[i].x - profile[i + 1].x);
        return profile[i + 1].y + t * (profile[i].y - profile[i + 1].y);
      }
    }
    return 0.65; // fallback
  }

  // Offset from _getPalateY (palate midline) to actual 3D palate mesh bottom surface.
  // Hard palate archHeight=0.12 → bottom is 0.12 below midline.
  // Alveolar ridge at x≈1.0 → _getPalateY already near bottom (archHeight=0.06 but
  // profile values already lowered to match), so offset is minimal.
  _meshBottomOffset(x) {
    if (x >= 1.00) return 0.01;
    if (x >= 0.95) return 0.01 + (1.00 - x) / 0.05 * 0.11;  // smooth transition
    return 0.12;
  }

  // Depth of the palate's inner (tongue-facing) surface at z=0 relative to
  // _getPalateY midline.  Derived from the actual buildArchFromProfile params:
  //   hard palate:      archH 0.12, thickness 0.04 → inner 0.08
  //   alveolar ridge:   archH 0.06, thickness 0.03 → inner 0.03
  //   velum:            archH 0.08, thickness 0.05 → inner 0.03
  _innerArchDepth(x) {
    if (x >= 1.00) return 0.01;          // past alveolar ridge — nearly flat
    if (x >= 0.95) {                      // transition: alveolar → hard palate
      const t = (1.00 - x) / 0.05;       // 0 at x=1.0, 1 at x=0.95
      return 0.01 + t * 0.07;            // 0.01 → 0.08
    }
    if (x >= -0.08) return 0.08;         // hard palate
    if (x >= -0.25) {                     // junction: hard palate → velum
      const t = (x + 0.25) / 0.17;       // 0 at x=-0.25, 1 at x=-0.08
      return 0.03 + t * 0.05;            // 0.03 → 0.08
    }
    return 0.03;                          // velum
  }

  // Clamp a tongue contour so no point exceeds palate ceiling.
  // The gap accounts for the 3D palate arch depth at z=0 (inner surface)
  // plus PALATE_GAP (0.015) plus a safety margin (0.01), ensuring the 3D
  // tongue mesh never intersects the palate from ANY viewing angle.
  // This eliminates the need for per-vertex clamping in the geometry builder,
  // which was the root cause of visible fold/crease artifacts.
  _clampContourToPalate(contour, gap = 0.03) {
    // Vowels need a larger margin so close vowels (especially central ones
    // like /ɨ/, /ʉ/) show a visible dip below the palate instead of touching.
    // Consonants keep the tight margin for near-contact articulations.
    const margin = this._isConsonant ? 0.025 : 0.055;
    return contour.map(p => {
      const palateY = this._getPalateY(p.x);
      const archGap = this._innerArchDepth(p.x) + margin;
      const effectiveGap = Math.max(gap, archGap);
      const maxY = palateY - effectiveGap;
      return { x: p.x, y: Math.min(p.y, maxY) };
    });
  }

  // ========================================
  // ========== TONGUE ==========
  // ========================================
  _buildTongue() {
    this.tongueMat = new THREE.MeshStandardMaterial({
      color: 0xd4736e,
      side: this.is3D ? THREE.FrontSide : THREE.DoubleSide,
      roughness: 0.65
    });
    this.tongueMesh = null;
    this._rebuildTongueMesh();
  }

  // Returns { upper: [{x,y},...], lower: [{x,y},...] } with matched point counts.
  // Both contours go from root to tip and are resampled to TONGUE_RESAMPLE points.
  _getTongueContours() {
    const t = this.currentTongue;
    const TONGUE_RESAMPLE = 32;

    // The tongue is a THICK muscular mass that fills most of the oral cavity.
    // MRI data shows the tongue sits on the floor of the mouth — the lower surface
    // rests against the mandible/genioglossus. Only the dorsum (upper surface) moves
    // significantly between vowels.

    // Floor of mouth: the INNER surface of the jaw where the tongue mucosa sits.
    // These are HIGHER than the outer jaw geometry points because the inner lining
    // (mylohyoid muscle, sublingual space) raises the effective floor.
    // Original jaw outer shell: (-0.48,-0.24), (-0.25,-0.12), (0.15,-0.04), (0.75,0.04), (1.15,0.10)
    // Inner surface sits ~0.10-0.15 above the outer shell at mid-mouth.
    const jawDrop = (this.currentJawOpen || 0.2) * 0.28;

    // Jaw inner top Y at a given x (piecewise linear — raised from outer shell)
    const jawInnerProfile = [
      { x: -0.48, y: -0.20 }, { x: -0.25, y: -0.02 }, { x: 0.15, y: 0.08 },
      { x: 0.75, y: 0.12 },  { x: 1.15, y: 0.14 },
    ];
    const jawTopY = (xPos) => {
      const jp = jawInnerProfile;
      if (xPos <= jp[0].x) return jp[0].y - jawDrop;
      if (xPos >= jp[jp.length - 1].x) return jp[jp.length - 1].y - jawDrop;
      for (let i = 0; i < jp.length - 1; i++) {
        if (xPos >= jp[i].x && xPos <= jp[i + 1].x) {
          const frac = (xPos - jp[i].x) / (jp[i + 1].x - jp[i].x);
          return (jp[i].y + frac * (jp[i + 1].y - jp[i].y)) - jawDrop;
        }
      }
      return -0.10 - jawDrop;
    };

    // Upper contour: pharyngeal anchor → root → body → front → blade → mid blade-tip → tip
    // Offsets reduced from previous values for more realistic thickness (less balloon-like)
    const midRBx = (t.root.x + t.body.x) / 2;
    const midRBy = (t.root.y + t.body.y) / 2;
    const midBTx = (t.blade.x + t.tip.x) / 2;
    const midBTy = (t.blade.y + t.tip.y) / 2;
    const upperCtrl = [
      { x: -0.55,             y: -0.35 },                   // pharyngeal anchor (deep in throat)
      { x: t.root.x - 0.05,  y: t.root.y - 0.02 },         // root — curves into throat
      { x: t.root.x,          y: t.root.y + 0.08 },         // root dorsum
      { x: midRBx,            y: midRBy + 0.14 },            // mid root-body
      { x: t.body.x,          y: t.body.y + 0.14 },          // body dorsum — full height
      { x: t.front.x,         y: t.front.y + 0.11 },         // front
      { x: t.blade.x,         y: t.blade.y + 0.08 },         // blade
      { x: midBTx,            y: midBTy + 0.05 },            // mid blade-tip (smooth taper)
      { x: t.tip.x,           y: t.tip.y + 0.03 },           // tip
    ];

    // Lower contour: whichever is HIGHER of (a) jaw floor or (b) upper - maxThickness.
    // When the tongue is low, it rests on the jaw floor.
    // When the tongue body rises (close vowels, velars), the lower surface lifts off
    // the jaw and tracks the upper contour at a fixed max thickness.
    const MAX_THICKNESS = 0.13;  // max tongue thickness in cross-section (~13mm)
    const bladeUpper = t.blade.y + 0.08;
    const tipUpper = t.tip.y + 0.03;

    // Helper: lower Y = max(jaw floor, upper_y - MAX_THICKNESS)
    const lowerY = (xPos, upperY) => {
      const jawFloor = jawTopY(xPos) + 0.01;
      return Math.max(jawFloor, upperY - MAX_THICKNESS);
    };

    const bodyUpper = t.body.y + 0.14;
    const frontUpper = t.front.y + 0.11;
    const midRBupper = midRBy + 0.14;
    const rootUpper = t.root.y + 0.08;
    const lowerCtrl = [
      { x: -0.55,             y: -0.42 },                           // pharyngeal anchor (below upper)
      { x: t.root.x - 0.05,  y: t.root.y - 0.10 },                 // root underside
      { x: t.root.x,          y: lowerY(t.root.x, rootUpper) },     // root — jaw or thickness limit
      { x: midRBx,            y: lowerY(midRBx, midRBupper) },      // mid root-body
      { x: t.body.x,          y: lowerY(t.body.x, bodyUpper) },     // body — jaw or thickness limit
      { x: t.front.x,         y: lowerY(t.front.x, frontUpper) },   // front — jaw or thickness limit
      { x: t.blade.x,         y: bladeUpper - 0.06 },               // blade rises toward dorsum
      { x: midBTx,            y: (bladeUpper + tipUpper) / 2 - 0.04 }, // mid blade-tip
      { x: t.tip.x,           y: tipUpper - 0.04 },                 // tip — 4mm below dorsum (blunt)
    ];

    // Resample both contours to the same point count via CatmullRom
    let upper = resampleContour(upperCtrl, TONGUE_RESAMPLE);
    let lower = resampleContour(lowerCtrl, TONGUE_RESAMPLE);

    // Clamp the upper contour so it never exceeds the palate ceiling.
    // Gap reduced from 0.045 to 0.035 since upper offsets are smaller now.
    upper = this._clampContourToPalate(upper, 0.035);

    // Also ensure lower contour doesn't exceed upper (would create inverted geometry)
    for (let i = 0; i < TONGUE_RESAMPLE; i++) {
      if (lower[i].y > upper[i].y - 0.02) {
        lower[i].y = upper[i].y - 0.02;
      }
    }

    return { upper, lower };
  }

  // Flat point list for cross-section mode (closed shape)
  _getTonguePoints() {
    const t = this.currentTongue;
    const jawDrop = (this.currentJawOpen || 0.2) * 0.28;

    // Jaw inner top Y at a given x (same raised values as _getTongueContours)
    const jawInnerProfile = [
      { x: -0.48, y: -0.20 }, { x: -0.25, y: -0.02 }, { x: 0.15, y: 0.08 },
      { x: 0.75, y: 0.12 },  { x: 1.15, y: 0.14 },
    ];
    const jawTopY = (xPos) => {
      const jp = jawInnerProfile;
      if (xPos <= jp[0].x) return jp[0].y - jawDrop;
      if (xPos >= jp[jp.length - 1].x) return jp[jp.length - 1].y - jawDrop;
      for (let i = 0; i < jp.length - 1; i++) {
        if (xPos >= jp[i].x && xPos <= jp[i + 1].x) {
          const frac = (xPos - jp[i].x) / (jp[i + 1].x - jp[i].x);
          return (jp[i].y + frac * (jp[i + 1].y - jp[i].y)) - jawDrop;
        }
      }
      return -0.10 - jawDrop;
    };

    const midRBx = (t.root.x + t.body.x) / 2;
    const midRBy = (t.root.y + t.body.y) / 2;
    const midBTx = (t.blade.x + t.tip.x) / 2;
    const midBTy = (t.blade.y + t.tip.y) / 2;
    const bladeUpper = t.blade.y + 0.08;
    const tipUpper = t.tip.y + 0.03;

    // Max thickness limit (same as _getTongueContours)
    const MAX_THICKNESS = 0.13;
    const lowerY = (xPos, upperY) => {
      const jawFloor = jawTopY(xPos) + 0.01;
      return Math.max(jawFloor, upperY - MAX_THICKNESS);
    };

    const bodyUpper = t.body.y + 0.14;
    const frontUpper = t.front.y + 0.11;
    const midRBupper = midRBy + 0.14;
    const rootUpper = t.root.y + 0.08;

    const pts = [
      // Upper contour (pharyngeal anchor → root → tip)
      { x: -0.55,             y: -0.35 },
      { x: t.root.x - 0.05,  y: t.root.y - 0.02 },
      { x: t.root.x,          y: rootUpper },
      { x: midRBx,            y: midRBupper },
      { x: t.body.x,          y: bodyUpper },
      { x: t.front.x,         y: frontUpper },
      { x: t.blade.x,         y: bladeUpper },
      { x: midBTx,            y: midBTy + 0.05 },
      { x: t.tip.x,           y: tipUpper },
      // Lower contour (tip → root → pharyngeal anchor) — jaw or thickness-limited
      { x: t.tip.x,           y: tipUpper - 0.04 },
      { x: midBTx,            y: (bladeUpper + tipUpper) / 2 - 0.04 },
      { x: t.blade.x,         y: bladeUpper - 0.06 },
      { x: t.front.x,         y: lowerY(t.front.x, frontUpper) },
      { x: t.body.x,          y: lowerY(t.body.x, bodyUpper) },
      { x: midRBx,            y: lowerY(midRBx, midRBupper) },
      { x: t.root.x,          y: lowerY(t.root.x, rootUpper) },
      { x: t.root.x - 0.05,  y: t.root.y - 0.10 },
      { x: -0.55,             y: -0.42 },
    ];
    // Clamp upper contour points (first 9: pharyngeal anchor through tip) to palate ceiling
    // For consonants, use mesh bottom offset to prevent clipping through 3D palate
    for (let i = 0; i < 9; i++) {
      const palateY = this._getPalateY(pts[i].x);
      const gap = this._isConsonant
        ? Math.max(0.035, this._meshBottomOffset(pts[i].x))
        : 0.035;
      pts[i].y = Math.min(pts[i].y, palateY - gap);
    }
    return pts;
  }

  _rebuildTongueMesh() {
    if (this.tongueMesh) {
      this.group.remove(this.tongueMesh);
      this.tongueMesh.geometry.dispose();
    }

    if (this.is3D) {
      // Full 3D tongue via swept elliptical cross-sections.
      // The upper contour is already clamped by _clampContourToPalate with
      // an arch-depth-aware gap, so the 3D mesh naturally stays below the
      // palate at all z positions without any per-vertex clamping.
      const { upper, lower } = this._getTongueContours();
      const geo = buildTongue3DGeometry(upper, lower);
      this.tongueMat.side = THREE.FrontSide;
      this.tongueMat.clippingPlanes = [];
      this.tongueMesh = new THREE.Mesh(geo, this.tongueMat);
    } else {
      // Cross-section extrusion (flat closed shape)
      const pts = this._getTonguePoints();
      const shape = smoothCurveShape(pts, true);
      this.tongueMat.side = THREE.DoubleSide;
      this.tongueMat.clippingPlanes = this.clippingPlanes;
      this.tongueMat.clipShadows = true;
      this.tongueMesh = makeExtruded(shape, this.tongueMat, DEPTH * 0.85);
      this.tongueMesh.position.z = 0.02;
    }

    this.group.add(this.tongueMesh);
    this.meshes.tongue = this.tongueMesh;
  }

  // ========================================
  // ========== JAW ==========
  // ========================================
  _buildJaw() {
    this.jawGroup = new THREE.Group();
    // Raised by +0.14 so the jaw/floor-of-mouth sits closer to palate,
    // giving a realistic oral cavity size for speech
    const pts = [
      { x: 1.45, y: 0.12 }, { x: 1.55, y: 0.02 }, { x: 1.35, y: -0.18 },
      { x: 0.75, y: -0.36 }, { x: 0.15, y: -0.41 }, { x: -0.25, y: -0.36 },
      { x: -0.48, y: -0.24 }, { x: -0.25, y: -0.12 }, { x: 0.15, y: -0.04 },
      { x: 0.75, y: 0.04 }, { x: 1.15, y: 0.10 },
    ];
    const shape = smoothCurveShape(pts, true);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc8b8a8, transparent: true, opacity: 0.2,
      side: THREE.DoubleSide, depthWrite: false, roughness: 0.85
    });
    const mesh = makeExtruded(shape, mat, DEPTH * 0.6);
    mesh.renderOrder = -1;
    this.jawGroup.add(mesh);
    this.group.add(this.jawGroup);
    this.meshes.jaw = this.jawGroup;
  }

  // ========================================
  // ========== UPPER TEETH ==========
  // ========================================
  _buildUpperTeeth() {
    if (this.is3D) {
      // A few small 3D tooth boxes arranged in an arc
      const toothMat = new THREE.MeshStandardMaterial({
        color: 0xf0e8e0, roughness: 0.3, metalness: 0.05
      });
      const toothGeo = new THREE.BoxGeometry(0.05, 0.18, 0.09);

      // Central incisors (2)
      const t1 = new THREE.Mesh(toothGeo, toothMat);
      t1.position.set(1.12, 0.42, 0.05);
      this.group.add(t1);
      const t2 = new THREE.Mesh(toothGeo.clone(), toothMat);
      t2.position.set(1.12, 0.42, -0.05);
      this.group.add(t2);

      // Lateral incisors (2)
      const smallToothGeo = new THREE.BoxGeometry(0.04, 0.15, 0.07);
      const t3 = new THREE.Mesh(smallToothGeo, toothMat);
      t3.position.set(1.10, 0.42, 0.15);
      t3.rotation.y = 0.15;
      this.group.add(t3);
      const t4 = new THREE.Mesh(smallToothGeo.clone(), toothMat);
      t4.position.set(1.10, 0.42, -0.15);
      t4.rotation.y = -0.15;
      this.group.add(t4);

      this.meshes.upperTeeth = t1;
    } else {
      const shape = new THREE.Shape();
      shape.moveTo(1.08, 0.55); shape.lineTo(1.14, 0.55);
      shape.lineTo(1.15, 0.32); shape.lineTo(1.08, 0.30);
      shape.lineTo(1.05, 0.50); shape.closePath();
      const mat = new THREE.MeshStandardMaterial({
        color: 0xf0e8e0, roughness: 0.3, metalness: 0.05
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.5);
      mesh.position.z = 0.03;
      this.group.add(mesh);
      this.meshes.upperTeeth = mesh;
    }
  }

  // ========================================
  // ========== LOWER TEETH ==========
  // ========================================
  _buildLowerTeeth() {
    if (this.is3D) {
      const toothMat = new THREE.MeshStandardMaterial({
        color: 0xf0e8e0, roughness: 0.3, metalness: 0.05
      });
      const toothGeo = new THREE.BoxGeometry(0.04, 0.13, 0.08);

      // Raised from y:0.08 → y:0.22 so lower teeth sit just below upper teeth (y:0.42)
      // giving a realistic inter-incisal gap at rest
      const t1 = new THREE.Mesh(toothGeo, toothMat);
      t1.position.set(1.08, 0.22, 0.04);
      this.jawGroup.add(t1);
      const t2 = new THREE.Mesh(toothGeo.clone(), toothMat);
      t2.position.set(1.08, 0.22, -0.04);
      this.jawGroup.add(t2);

      this.meshes.lowerTeeth = t1;
    } else {
      // Raised by +0.14 to match 3D adjustment
      const shape = new THREE.Shape();
      shape.moveTo(1.04, 0.12); shape.lineTo(1.10, 0.12);
      shape.lineTo(1.12, 0.28); shape.lineTo(1.05, 0.30);
      shape.lineTo(1.02, 0.16); shape.closePath();
      const mat = new THREE.MeshStandardMaterial({
        color: 0xf0e8e0, roughness: 0.3, metalness: 0.05
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.5);
      mesh.position.z = 0.03;
      this.jawGroup.add(mesh);
      this.meshes.lowerTeeth = mesh;
    }
  }

  // ========================================
  // ========== UPPER LIP ==========
  // ========================================
  _buildUpperLip() {
    if (this.is3D) {
      this._rebuildLips3D();
    } else {
      const lipShape = new THREE.Shape();
      lipShape.moveTo(1.16, 0.56);
      lipShape.quadraticCurveTo(1.28, 0.66, 1.40, 0.60);
      lipShape.quadraticCurveTo(1.48, 0.53, 1.44, 0.44);
      lipShape.quadraticCurveTo(1.36, 0.38, 1.24, 0.40);
      lipShape.quadraticCurveTo(1.16, 0.44, 1.16, 0.56);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc46868, roughness: 0.5, metalness: 0.02
      });
      this.upperLipMesh = makeExtruded(lipShape, mat, DEPTH * 0.7);
      this.upperLipMesh.renderOrder = 2;
      this.upperLipMesh.position.z = 0.04;
      this.group.add(this.upperLipMesh);
      this.meshes.upperLip = this.upperLipMesh;
    }
  }

  // ========================================
  // ========== LOWER LIP ==========
  // ========================================
  _buildLowerLip() {
    if (this.is3D) {
      // handled by _rebuildLips3D which builds both
      return;
    }
    const lipShape = new THREE.Shape();
    lipShape.moveTo(1.16, 0.26);
    lipShape.quadraticCurveTo(1.28, 0.16, 1.40, 0.20);
    lipShape.quadraticCurveTo(1.48, 0.26, 1.44, 0.34);
    lipShape.quadraticCurveTo(1.36, 0.38, 1.24, 0.36);
    lipShape.quadraticCurveTo(1.16, 0.32, 1.16, 0.26);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc46868, roughness: 0.5, metalness: 0.02
    });
    this.lowerLipMesh = makeExtruded(lipShape, mat, DEPTH * 0.7);
    this.lowerLipMesh.renderOrder = 2;
    this.lowerLipMesh.position.z = 0.04;
    this.jawGroup.add(this.lowerLipMesh);
    this.meshes.lowerLip = this.lowerLipMesh;
  }

  // ========================================
  // ========== 3D LIPS (tube rings) ==========
  // ========================================
  _rebuildLips3D() {
    const { rounding, openness, protrusion, spread } = this.currentLips;

    // Remove old lip meshes
    if (this.upperLipMesh) {
      this.upperLipMesh.parent?.remove(this.upperLipMesh);
      this.upperLipMesh.geometry.dispose();
    }
    if (this.lowerLipMesh) {
      this.lowerLipMesh.parent?.remove(this.lowerLipMesh);
      this.lowerLipMesh.geometry.dispose();
    }

    const lipMat = new THREE.MeshStandardMaterial({
      color: 0xc46868, roughness: 0.5, metalness: 0.02
    });

    // Mouth center and size — now positioned right in front of teeth
    const cx = 1.30 + protrusion * 0.12;
    const cy = 0.40;
    const halfW = HALF * 0.45 * (1 - rounding * 0.3) * (1 + spread * 0.2);
    const halfH = 0.09 + openness * 0.08;
    const radius = 0.04 + rounding * 0.03;

    // Upper lip
    const upperGeo = buildLipTube(
      { x: cx, y: cy }, halfW, halfH, radius, true, protrusion * 0.1
    );
    this.upperLipMesh = new THREE.Mesh(upperGeo, lipMat);
    this.upperLipMesh.renderOrder = 2;
    this.group.add(this.upperLipMesh);
    this.meshes.upperLip = this.upperLipMesh;

    // Lower lip
    const lowerGeo = buildLipTube(
      { x: cx, y: cy }, halfW, halfH, radius * 1.1, false, protrusion * 0.1
    );
    this.lowerLipMesh = new THREE.Mesh(lowerGeo, lipMat.clone());
    this.lowerLipMesh.renderOrder = 2;
    this.jawGroup.add(this.lowerLipMesh);
    this.meshes.lowerLip = this.lowerLipMesh;
  }

  // =============================================
  // PUBLIC API
  // =============================================

  setSkinVisible(visible) {
    this.skinVisible = visible;
    this.skinGroup.visible = visible;
  }

  toggleSkin() {
    this.setSkinVisible(!this.skinVisible);
    return this.skinVisible;
  }

  setTonguePosition(params) {
    if (!params) return;

    // Safety net: if tip/blade specified without body, default to neutral body
    // to prevent stale control point positions from previous sounds.
    if ((params.tip || params.blade) && !params.body) {
      params = { ...params, body: { height: 0.45, frontness: 0.50 } };
    }

    const t = this.currentTongue;
    const n = this.neutralTongue;

    // --- Coordinate ranges (based on MRI articulatory data) ---
    // Oral cavity: pharynx at x≈-0.50, teeth at x≈1.10
    // Palate: y≈0.60-0.72 at its peak (hard palate peak at x≈0.70)
    // Floor of mouth: y≈-0.20
    //
    // VOWELS (no explicit tip): body height maps directly to tongue height
    //   height 0.80 → close vowels (/i/,/u/): dorsum at 80-90% of palate
    //   height 0.50 → mid vowels: ~50% of palate
    //   height 0.20 → open vowels (/a/,/ɑ/): tongue flat and low
    //
    // CONSONANTS (explicit tip): body stays relatively neutral (40-55% per MRI)
    //   The tip does the articulatory work, body follows passively.

    const hasTip = !!params.tip;
    const hasBlade = !!params.blade;
    // Extract height early — used for body, root, blade/tip auto-derivation
    const h = params.body?.height ?? 0.5;

    // Determine if the tip is the active articulator (raised high) or passive (low/rest).
    // If tip y > 0.55, the tip is doing the work (alveolars, dentals, postalveolars)
    //   → body should be damped to neutral (40-55% per MRI data).
    // If tip y <= 0.55, the body/dorsum is the active articulator (velars, palatals)
    //   → body should map to full range (can be high).
    // Threshold at 0.55 keeps palatals (tip.y≈0.40) on the full-range path
    // while damping alveolars/dentals (tip.y≈0.95+).
    const tipIsActive = hasTip && (params.tip.y ?? 0.35) > 0.55;

    if (params.body) {
      const f = params.body.frontness ?? 0.5;

      // Body X position: frontness 0→1 maps x from -0.35 (back/pharyngeal) to 0.50 (front/palatal)
      t.body.x = -0.35 + f * 0.85;

      if (tipIsActive) {
        // CONSONANT where TIP is the active articulator (alveolars, dentals, postalveolars).
        // MRI shows body stays neutral at 40-55% height.
        // Dampen body height but keep it moderate — too-low body creates an
        // unnatural steep slope to the tip that looks like a fold/kink in 3D.
        const dampedH = h * 0.75;
        t.body.y = -0.02 + dampedH * 0.55;
      } else {
        // VOWEL or consonant where BODY/DORSUM is the active articulator (velars, palatals).
        // S-curve mapping for EXAGGERATED contrast: open vowels much lower (flat),
        // close vowels higher (dramatic arch). This makes tongue positions obvious
        // for learners — the visual difference between /a/ and /i/ is unmistakable.
        //   h=0.20 (/a/) → body.y≈-0.17 (very low, tongue lies flat)
        //   h=0.50 (/ə/) → body.y≈0.14  (moderate, clearly neutral)
        //   h=0.75 (/i/) → body.y≈0.40  (high arch, dramatic)
        //   h=0.92 (/ŋ/) → body.y≈0.51  (near-contact, clamped by palate)
        const hCurve = h <= 0.5
          ? 0.5 * Math.pow(2 * h, 1.6)
          : 1.0 - 0.5 * Math.pow(2 * (1 - h), 1.6);
        t.body.y = -0.25 + hCurve * 0.78;
        // Tongue body has muscle bulk (~13mm thick) — it doesn't flatten as
        // much as the S-curve suggests for open vowels. Lift proportionally.
        if (h < 0.5) {
          t.body.y += (0.5 - h) * 0.18;
        }
      }

      // Front follows body, positioned between body and blade
      if (tipIsActive) {
        // For consonants where tip does the work, front smoothly bridges body to tip
        t.front.x = t.body.x + 0.22 + f * 0.12;
        t.front.y = t.body.y + 0.05; // front starts rising above body toward blade
      } else {
        // For vowels and body-active consonants, front follows the dorsum arch
        t.front.x = t.body.x + 0.20 + f * 0.15;
        // Close vowels: front dips below body (arch peaks at body).
        // Open vowels: front starts dipping toward the blade valley.
        // Mid vowels: slight rise above body.
        if (h > 0.6) {
          t.front.y = t.body.y - 0.04;
        } else if (h < 0.5) {
          const frontDip = (0.5 - h) * 0.08;
          t.front.y = t.body.y - frontDip;
        } else {
          t.front.y = t.body.y + 0.03;
        }
      }

      // Auto-adjust blade when not explicitly set
      if (!hasBlade) {
        if (tipIsActive) {
          // For consonants with active tip, blade smoothly interpolates between front and tip
          t.blade.x = t.front.x + 0.15 + f * 0.08;
          // Blade y will be set after tip is resolved (see below)
        } else {
          // For vowels and body-active consonants, blade follows body/front contour
          t.blade.x = Math.min(t.front.x + 0.18 + f * 0.08, 0.95);
          // Open vowels: blade is the thinnest part of the tongue — it dips into
          // a valley when the jaw opens wide. The dip scales with openness.
          // Close/mid vowels: blade follows the dorsum arch smoothly.
          if (h < 0.5) {
            const bladeDip = (0.5 - h) * 0.22;
            t.blade.y = t.front.y - bladeDip;
          } else {
            const bladeFollow = Math.min(h * 1.1, 0.92);
            const bladeRest = Math.min(t.front.y + 0.02, n.blade.y);
            t.blade.y = t.front.y * bladeFollow + bladeRest * (1 - bladeFollow);
          }
        }
      }

      // Auto-adjust tip when not explicitly set
      if (!hasTip) {
        const baseX = hasBlade ? t.blade.x : t.front.x + 0.18 + f * 0.08;
        // Scale tip extension by height: close vowels extend tip forward (raised arch),
        // open vowels keep tip near blade (tongue lies flat, tip rests behind lower teeth).
        // h=0.75 → extend=0.21, h=0.50 → extend=0.14, h=0.20 → extend=0.06
        const tipExtend = 0.06 + h * 0.20 + (h > 0.5 ? (h - 0.5) * f * 0.12 : 0);
        t.tip.x = baseX + tipExtend;
        // Clamp tip so it doesn't extend past behind lower teeth
        t.tip.x = Math.min(t.tip.x, 1.02);
        // Open vowels: tip recovers partially from the blade dip — it rests
        // against the lower teeth/gum ridge, sitting above the blade valley.
        // Close/mid vowels: tip follows blade along the arch.
        if (h < 0.5) {
          const tipRecovery = (0.5 - h) * 0.15;
          t.tip.y = t.blade.y + tipRecovery;
        } else {
          const tipFollow = Math.min(h * 0.9, 0.78);
          const tipRest = Math.min(t.blade.y + 0.02, 0.05 + h * 0.20);
          t.tip.y = t.blade.y * tipFollow + tipRest * (1 - tipFollow);
        }
      }
    }

    if (params.tip) {
      // Explicit tip placement (consonants)
      // x: 0→1 maps from x=-0.10 to x=1.15 (from mid-mouth to teeth)
      // Upper teeth at x≈1.10-1.15, alveolar ridge at x≈0.88-1.08
      t.tip.x = -0.10 + params.tip.x * 1.25;

      // Y positioning is PALATE-RELATIVE for high tip values:
      // The palate at each x position is the ceiling. The y parameter controls
      // how high the tip reaches toward (or onto) that ceiling.
      //   y >= 0.5: tip approaches/contacts palate (palate-relative positioning)
      //     y=0.5 → halfway between floor and palate
      //     y=0.7 → very close to palate (narrow gap for fricatives)
      //     y=1.0 → at palate (contact)
      //   y < 0.5: tip stays low (absolute positioning, for rest/low tip)
      const palateY = this._getPalateY(t.tip.x);
      const mbo = this._meshBottomOffset(t.tip.x);
      const py = params.tip.y ?? 0.35;

      if (params.tip.contact) {
        // Contact consonants (/t/,/d/,/n/,/r/,/ɾ/,/l/,/ɬ/,/ɮ/):
        // Tip snaps to palate MESH bottom surface (not midline).
        // Subtract mesh offset and contour offset so the visible tip
        // (control point + 0.03 contour offset) just touches the palate bottom.
        t.tip.y = palateY - mbo - 0.03;
      } else {
        // Non-contact tip placement (fricatives, approximants, rest position):
        // y is a 0-1 PALATE-RELATIVE parameter, ceiling = palate mesh bottom.
        // Subtract contour offset so that at py=1.0 the visible contour
        // (control + 0.03) just reaches the palate mesh bottom.
        const ceiling = palateY - mbo - 0.03;
        const floor = -0.15;
        t.tip.y = floor + py * (ceiling - floor);
      }
    }

    if (params.blade) {
      t.blade.x = -0.15 + params.blade.x * 1.05;
      // Blade y is palate-relative; ceiling = palate mesh bottom minus contour offset
      const bladePalateY = this._getPalateY(t.blade.x);
      const bladeMbo = this._meshBottomOffset(t.blade.x);
      const bladeCeiling = bladePalateY - bladeMbo - 0.08; // 0.08 = blade contour offset
      const bladeFloor = -0.15;
      t.blade.y = bladeFloor + params.blade.y * (bladeCeiling - bladeFloor);
    }

    // After tip is set, smooth the blade for consonants if blade wasn't explicit
    if (tipIsActive && !hasBlade && params.body) {
      // Blade position: between front and tip, with y interpolated smoothly
      // This creates a gentle scoop up from body to tip, not a sharp hook
      t.blade.x = (t.front.x + t.tip.x) / 2;
      // Smooth y interpolation: weighted blend — blade rises gradually
      t.blade.y = t.front.y * 0.35 + t.tip.y * 0.65;
    }
    // For velars/palatals with explicit low tip, auto-derive blade from body contour
    if (hasTip && !tipIsActive && !hasBlade && params.body) {
      t.blade.x = t.front.x + 0.18 + (params.body.frontness ?? 0.5) * 0.08;
      t.blade.y = t.body.y * 0.45 + n.blade.y * 0.55;
      t.tip.x = t.blade.x + 0.18 + (params.body.frontness ?? 0.5) * 0.06;
      // For body-active consonants, tip stays low
      t.tip.y = params.tip.y !== undefined ? t.tip.y : t.body.y * 0.3 + n.tip.y * 0.7;
    }

    // ---- Smooth front for tip-active consonants ----
    // When the tip is the active articulator (alveolars, dentals, clicks, affricates),
    // the body is dampened low but blade/tip are high near the palate.
    // If front stays at body level, the CatmullRom spline overshoots between
    // front and blade, creating a visible downward swoop/kink.
    // Fix: raise front to smoothly ramp from body toward blade/tip.
    if (tipIsActive && params.body) {
      // For explicit blade: ramp body→blade. For auto blade: ramp body→tip.
      const rampTarget = hasBlade ? t.blade.y : t.tip.y;
      const rampTargetX = hasBlade ? t.blade.x : t.tip.x;
      const dx = rampTargetX - t.body.x;
      if (dx > 0.01) {
        const frontFrac = Math.min(1.0, (t.front.x - t.body.x) / dx);
        const smoothFrontY = t.body.y + frontFrac * (rampTarget - t.body.y);
        t.front.y = Math.max(t.front.y, smoothFrontY);
      }
      // Also smooth auto-derived blade along body→tip ramp
      if (!hasBlade) {
        const tipDx = t.tip.x - t.body.x;
        if (tipDx > 0.01) {
          const bladeFrac = (t.blade.x - t.body.x) / tipDx;
          const smoothBladeY = t.body.y + bladeFrac * (t.tip.y - t.body.y);
          t.blade.y = Math.max(t.blade.y, smoothBladeY);
        }
      }
    }

    if (params.root) {
      const adv = params.root.advancement ?? 0.5;
      t.root.x = -0.58 + adv * 0.25;
      // Root Y: raise base to reduce the steep back-to-body slope that makes
      // neutral/open vowels look like the back is raised. For low vowels (h<0.55),
      // boost root further so the tongue profile looks flat.
      const rootLift = Math.max(0, 0.55 - h) * 0.28;
      t.root.y = (-0.30 + adv * 0.15) + rootLift;
    }

    // Final palate clamping: ensure no control point exceeds the palate ceiling.
    // Consonants must account for the 3D palate mesh thickness (the mesh bottom
    // surface is _meshBottomOffset below _getPalateY). Vowels use simpler gaps.
    const isConsonant = !!(params.tip || params.blade);
    // Body-active consonants (implosives/ejectives at palatal/velar/uvular places)
    // have no tip/blade but still need mesh-aware clamping to prevent clipping.
    const bodyContact = params.body && params.body.height >= 0.88;
    this._isConsonant = isConsonant || bodyContact;

    const clampY = (pt, gap = 0.025) => {
      const palateY = this._getPalateY(pt.x);
      pt.y = Math.min(pt.y, palateY - gap);
    };

    if (isConsonant) {
      // Consonant clamping: gap = contour_offset + meshBottomOffset [+ visual_gap]
      // This ensures the upper contour (control_point + offset) stays at or below
      // the actual 3D palate mesh bottom surface.
      const bodyMbo = this._meshBottomOffset(t.body.x);
      const frontMbo = this._meshBottomOffset(t.front.x);
      const bladeMbo = this._meshBottomOffset(t.blade.x);
      clampY(t.body, bodyContact ? (0.14 + bodyMbo) : (0.14 + bodyMbo + 0.025));
      clampY(t.front, bodyContact ? (0.11 + frontMbo) : (0.11 + frontMbo + 0.025));
      clampY(t.blade, 0.08 + bladeMbo + 0.025);
    } else if (bodyContact) {
      // Body-active consonant without tip (e.g., palatal/velar implosives/ejectives):
      // use mesh-aware gaps to prevent clipping through 3D palate mesh
      const bodyMbo = this._meshBottomOffset(t.body.x);
      const frontMbo = this._meshBottomOffset(t.front.x);
      clampY(t.body, 0.14 + bodyMbo);
      clampY(t.front, 0.11 + frontMbo);
      clampY(t.blade, 0.105);
    } else {
      // Vowel clamping: contour_offset + 0.055 margin ensures visible gap
      // below palate, especially for central close vowels (/ɨ/, /ʉ/) where
      // the palate is lower than at front (/i/) or back (/u/) positions.
      clampY(t.body, 0.195);
      clampY(t.front, 0.165);
      clampY(t.blade, 0.135);
    }

    // Tip clamping depends on consonant type:
    if (params.tip && params.tip.contact) {
      // Contact consonants: tip already placed at palate mesh bottom — safety clamp only
      const palateY = this._getPalateY(t.tip.x);
      const tipMbo = this._meshBottomOffset(t.tip.x);
      t.tip.y = Math.min(t.tip.y, palateY - tipMbo - 0.03);
    } else if (params.tip) {
      // Non-contact consonants: account for mesh thickness
      const tipMbo = this._meshBottomOffset(t.tip.x);
      clampY(t.tip, 0.03 + tipMbo + 0.01);
    } else {
      // Vowels: standard gap
      clampY(t.tip);
    }

    this._rebuildTongueMesh();
  }

  setLipShape(params) {
    if (!params) return;
    this.currentLips = { ...this.currentLips, ...params };

    if (this.is3D) {
      this._rebuildLips3D();
      return;
    }

    // Cross-section mode: original extrusion approach
    const { rounding, openness, protrusion, spread } = this.currentLips;

    if (this.upperLipMesh) {
      this.group.remove(this.upperLipMesh);
      this.upperLipMesh.geometry.dispose();
    }
    const prot = protrusion * 0.12;
    const rnd = rounding * 0.06;
    const spr = spread * 0.04;
    const open = openness * 0.12;

    const upperShape = new THREE.Shape();
    upperShape.moveTo(1.16 - spr, 0.56 + open * 0.3);
    upperShape.quadraticCurveTo(1.28 + prot, 0.66 + rnd + open * 0.2, 1.40 + prot, 0.60 + rnd);
    upperShape.quadraticCurveTo(1.48 + prot, 0.53, 1.44 + prot, 0.44 + open * 0.15);
    upperShape.quadraticCurveTo(1.36 + prot, 0.38 + open * 0.1, 1.24 + prot, 0.40 + open * 0.05);
    upperShape.quadraticCurveTo(1.16 - spr, 0.44 + open * 0.05, 1.16 - spr, 0.56 + open * 0.3);

    const lipMat = new THREE.MeshStandardMaterial({
      color: 0xc46868, roughness: 0.5, metalness: 0.02,
      clippingPlanes: this.clippingPlanes, clipShadows: true
    });
    const lipWidth = DEPTH * 0.7 * (1 - rounding * 0.3);
    this.upperLipMesh = makeExtruded(upperShape, lipMat, lipWidth);
    this.upperLipMesh.renderOrder = 2;
    this.upperLipMesh.position.z = 0.04;
    this.group.add(this.upperLipMesh);
    this.meshes.upperLip = this.upperLipMesh;

    if (this.lowerLipMesh) {
      this.jawGroup.remove(this.lowerLipMesh);
      this.lowerLipMesh.geometry.dispose();
    }
    const lowerShape = new THREE.Shape();
    lowerShape.moveTo(1.16 - spr, 0.26 - open * 0.3);
    lowerShape.quadraticCurveTo(1.28 + prot, 0.16 - rnd - open * 0.2, 1.40 + prot, 0.20 - rnd);
    lowerShape.quadraticCurveTo(1.48 + prot, 0.26, 1.44 + prot, 0.34 - open * 0.1);
    lowerShape.quadraticCurveTo(1.36 + prot, 0.38 - open * 0.1, 1.24 + prot, 0.36 - open * 0.05);
    lowerShape.quadraticCurveTo(1.16 - spr, 0.32, 1.16 - spr, 0.26 - open * 0.3);
    this.lowerLipMesh = makeExtruded(lowerShape, lipMat.clone(), lipWidth);
    this.lowerLipMesh.renderOrder = 2;
    this.lowerLipMesh.position.z = 0.04;
    this.jawGroup.add(this.lowerLipMesh);
    this.meshes.lowerLip = this.lowerLipMesh;
  }

  setVelumHeight(height) {
    this.currentVelumHeight = height;
    const angle = (1 - height) * 0.5;
    this.velumGroup.rotation.z = -angle;
    this.velumGroup.position.x = Math.sin(angle) * 0.1;
    this.velumGroup.position.y = -(1 - Math.cos(angle)) * 0.1;
  }

  setJawOpenness(openness) {
    this.currentJawOpen = openness;
    // Jaw drop multiplier 0.28 gives realistic range:
    //   openness=0.1 (/i/) → drop=0.028 (barely open)
    //   openness=0.25 (/ə/) → drop=0.07 (moderate)
    //   openness=0.6 (/a/) → drop=0.168 (clearly open)
    const drop = openness * 0.28;
    this.jawGroup.position.y = -drop;
    this.jawGroup.rotation.z = -openness * 0.04;
  }

  setVoicing(voiced) {
    this.voicingActive = voiced;
    if (!voiced && this.vocalFold1 && this.vocalFold2) {
      this.vocalFold1.material.color.setHex(0x78909c);
      this.vocalFold1.material.emissive.setHex(0x000000);
      this.vocalFold1.material.emissiveIntensity = 0;
      this.vocalFold2.material.color.setHex(0x78909c);
      this.vocalFold2.material.emissive.setHex(0x000000);
      this.vocalFold2.material.emissiveIntensity = 0;
      this.vocalFold1.position.y = -0.73;
      this.vocalFold2.position.y = -0.82;
    }
  }

  resetToNeutral() {
    this.currentTongue = JSON.parse(JSON.stringify(this.neutralTongue));
    this._rebuildTongueMesh();
    this.setLipShape(this.neutralLips);
    this.setVelumHeight(this.neutralVelumHeight);
    this.setJawOpenness(this.neutralJawOpen);
    this.setVoicing(false);
  }

  getMeshes() { return { ...this.meshes }; }

  update(deltaTime) {
    if (this.voicingActive && this.vocalFold1 && this.vocalFold2) {
      this.voicingTime += deltaTime * 12;
      const pulse = Math.sin(this.voicingTime) * 0.5 + 0.5;
      const vibration = Math.sin(this.voicingTime * 2) * 0.015;
      this.vocalFold1.material.color.setHex(0x4caf50);
      this.vocalFold1.material.emissive.setHex(0x4caf50);
      this.vocalFold1.material.emissiveIntensity = pulse * 0.6;
      this.vocalFold1.position.y = -0.73 + vibration;
      this.vocalFold2.material.color.setHex(0x4caf50);
      this.vocalFold2.material.emissive.setHex(0x4caf50);
      this.vocalFold2.material.emissiveIntensity = pulse * 0.6;
      this.vocalFold2.position.y = -0.82 - vibration;
    }
  }

  getArticulatorPositions() {
    return {
      'Lips': new THREE.Vector3(1.35, 0.42, 0),
      'Upper Teeth': new THREE.Vector3(1.12, 0.42, 0),
      'Lower Teeth': new THREE.Vector3(1.10, 0.08, 0),
      'Alveolar Ridge': new THREE.Vector3(1.00, 0.70, 0),
      'Hard Palate': new THREE.Vector3(0.50, 0.72, 0),
      'Soft Palate (Velum)': new THREE.Vector3(-0.28, 0.58, 0),
      'Uvula': new THREE.Vector3(-0.52, 0.30, 0),
      'Tongue Tip': new THREE.Vector3(this.currentTongue.tip.x, this.currentTongue.tip.y + 0.10, 0),
      'Tongue Blade': new THREE.Vector3(this.currentTongue.blade.x, this.currentTongue.blade.y + 0.14, 0),
      'Tongue Body': new THREE.Vector3(this.currentTongue.body.x, this.currentTongue.body.y + 0.20, 0),
      'Tongue Root': new THREE.Vector3(this.currentTongue.root.x, this.currentTongue.root.y, 0),
      'Pharyngeal Wall': new THREE.Vector3(-0.72, 0.1, 0),
      'Epiglottis': new THREE.Vector3(-0.18, -0.38, 0),
      'Larynx': new THREE.Vector3(-0.38, -0.90, 0),
      'Nasal Cavity': new THREE.Vector3(0.50, 1.02, 0),
    };
  }
}
