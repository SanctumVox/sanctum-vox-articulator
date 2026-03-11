import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import VocalTract from './vocal-tract.js';
import IPA_DATA from './ipa-data.js';

// ============================================
// APP STATE
// ============================================
const state = {
  currentSound: null,
  previousSound: null,
  recentSounds: [],
  isPlaying: false,
  looping: false,
  speed: 1,
  labelsVisible: true,
  airflowVisible: false,
  compareMode: false,
  compareSlot: 1,
  compareSound1: null,
  compareSound2: null,
  infoPanelOpen: false,
  darkMode: true,
  currentView: 'side',
  muted: false,
};

// ============================================
// THREE.JS SETUP
// ============================================
const canvas = document.getElementById('three-canvas');
const viewport = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setClearColor(0x0B1221);
renderer.localClippingEnabled = false; // starts in 3D mode; enabled when cross-section toggled

const scene = new THREE.Scene();

// Clipping plane at z=0 — slices internal structures to show mid-sagittal cross-section
const clippingPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

// Camera
const camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.1, 100);
camera.position.set(0.3, 0.1, 5.5);
camera.lookAt(0.2, 0.1, 0);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(2, 3, 5);
scene.add(dirLight);
const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
backLight.position.set(-2, -1, -3);
scene.add(backLight);

// Controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0.2, 0.1, 0);
controls.update();

// Vocal Tract — defaults to full 3D; clipping plane used for cross-section toggle
const vocalTract = new VocalTract(scene, [clippingPlane]);
window._vt = vocalTract; // debug access

// Add a front light for the 3D mouth-open view
const frontLight = new THREE.DirectionalLight(0xffffff, 0.5);
frontLight.position.set(5, 1, 0);
scene.add(frontLight);

// ============================================
// CAMERA VIEWS
// ============================================
const cameraViews = {
  side:  { pos: new THREE.Vector3(0.3, 0.1, 5.5),  target: new THREE.Vector3(0.2, 0.1, 0) },
  front: { pos: new THREE.Vector3(4.5, 0.2, 0),     target: new THREE.Vector3(0.2, 0.1, 0) },
  top:   { pos: new THREE.Vector3(0.2, 5.5, 0.5),   target: new THREE.Vector3(0.2, 0, 0) },
  free:  { pos: new THREE.Vector3(2.5, 1.8, 3.5),   target: new THREE.Vector3(0.2, 0.1, 0) },
};

let cameraAnimating = false;
let cameraStartPos = new THREE.Vector3();
let cameraEndPos = new THREE.Vector3();
let cameraStartTarget = new THREE.Vector3();
let cameraEndTarget = new THREE.Vector3();
let cameraT = 0;

function setCameraView(viewName) {
  const view = cameraViews[viewName];
  if (!view) return;
  state.currentView = viewName;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
  cameraStartPos.copy(camera.position);
  cameraEndPos.copy(view.pos);
  cameraStartTarget.copy(controls.target);
  cameraEndTarget.copy(view.target);
  cameraT = 0;
  cameraAnimating = true;
}

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => setCameraView(btn.dataset.view));
});

// ============================================
// TWEEN SYSTEM
// ============================================
class TweenManager {
  constructor() { this.tweens = []; }

  tween(target, props, duration, onUpdate) {
    const start = {};
    const end = {};
    for (const [key, val] of Object.entries(props)) {
      if (typeof val === 'object' && target[key]) {
        start[key] = { ...target[key] };
        end[key] = { ...target[key], ...val };
      } else {
        start[key] = target[key];
        end[key] = val;
      }
    }
    this.tweens.push({ target, start, end, duration, elapsed: 0, onUpdate });
  }

  update(dt) {
    this.tweens = this.tweens.filter(tw => {
      tw.elapsed += dt;
      const t = Math.min(tw.elapsed / tw.duration, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out cubic

      for (const [key, endVal] of Object.entries(tw.end)) {
        if (typeof endVal === 'object') {
          if (!tw.target[key]) tw.target[key] = {};
          for (const [k2, v2] of Object.entries(endVal)) {
            const s = tw.start[key][k2] ?? v2;
            tw.target[key][k2] = s + (v2 - s) * ease;
          }
        } else if (typeof endVal === 'number') {
          const s = tw.start[key] ?? endVal;
          tw.target[key] = s + (endVal - s) * ease;
        } else {
          if (t >= 1) tw.target[key] = endVal;
        }
      }
      if (tw.onUpdate) tw.onUpdate(tw.target, t);
      return t < 1;
    });
  }

  cancel() { this.tweens = []; }
  get active() { return this.tweens.length > 0; }
}

const tweenMgr = new TweenManager();

// ============================================
// SOUND SELECTION & ANIMATION
// ============================================
function selectSound(symbol) {
  const sound = IPA_DATA.sounds[symbol];
  if (!sound) return;

  state.previousSound = state.currentSound;
  state.currentSound = sound;

  // Update display
  document.getElementById('current-symbol').textContent = sound.symbol;
  document.getElementById('current-name').textContent = sound.name;

  // Update voicing indicator
  const vi = document.getElementById('voicing-indicator');
  vi.className = sound.voiced ? 'voicing-on' : 'voicing-off';
  vi.querySelector('.voicing-label').textContent = sound.voiced ? 'Voiced' : 'Voiceless';

  // Update active button
  document.querySelectorAll('.ipa-btn.active, .vowel-btn.active').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`[data-symbol="${CSS.escape(symbol)}"]`);
  if (btn) btn.classList.add('active');

  // Add to recent
  addToRecent(symbol);

  // Update info panel
  updateInfoPanel(sound);

  // Update adjustment sliders
  updateSlidersFromSound(sound);

  // Handle comparison mode
  if (state.compareMode) {
    handleCompareSelect(sound);
    return;
  }

  // Animate
  animateToSound(sound);

  // Play audio for the sound
  playIPASound(sound.symbol);
}

function animateToSound(sound) {
  tweenMgr.cancel();
  const art = sound.articulators;
  const duration = 0.5 / state.speed;

  // Animate tongue — always animate so tongue moves to correct position
  // for every sound (including bilabials/labiodentals that lack tongue data).
  {
    const params = {};
    const isVowel = sound.type === 'vowel';
    if (art.tongue_tip && !isVowel) params.tip = { x: art.tongue_tip.x, y: art.tongue_tip.y, contact: !!art.tongue_tip.contact };
    if (art.tongue_blade && !isVowel) params.blade = { x: art.tongue_blade.x, y: art.tongue_blade.y };
    params.body = art.tongue_body
      ? { height: art.tongue_body.height, frontness: art.tongue_body.frontness }
      : { height: 0.45, frontness: 0.50 };
    if (art.tongue_root) params.root = { advancement: art.tongue_root.advancement };

    // 1. Capture start tongue positions
    const startTongue = JSON.parse(JSON.stringify(vocalTract.currentTongue));

    // 2. Compute end positions by calling setTonguePosition once
    const targetIsConsonant = !isVowel;
    vocalTract.setTonguePosition(params);
    const endTongue = JSON.parse(JSON.stringify(vocalTract.currentTongue));

    // 3. Restore start positions and rebuild
    const tongueKeys = ['tip', 'blade', 'front', 'body', 'root'];
    for (const k of tongueKeys) {
      vocalTract.currentTongue[k].x = startTongue[k].x;
      vocalTract.currentTongue[k].y = startTongue[k].y;
    }
    vocalTract._rebuildTongueMesh();

    // 4. Tween t from 0→1, lerping each control point
    const tweenTarget = { t: 0 };
    tweenMgr.tween(tweenTarget, { t: 1 }, duration, (tgt) => {
      const t = tgt.t;
      for (const k of tongueKeys) {
        vocalTract.currentTongue[k].x = startTongue[k].x + (endTongue[k].x - startTongue[k].x) * t;
        vocalTract.currentTongue[k].y = startTongue[k].y + (endTongue[k].y - startTongue[k].y) * t;
      }
      vocalTract._isConsonant = targetIsConsonant;
      vocalTract._rebuildTongueMesh();
    });
  }

  // Animate lips
  if (art.lips) {
    const lipTarget = { ...vocalTract.currentLips };
    tweenMgr.tween(lipTarget, art.lips, duration, (tgt) => {
      vocalTract.setLipShape(tgt);
    });
  }

  // Animate velum
  if (art.velum) {
    const velTarget = { h: vocalTract.currentVelumHeight };
    tweenMgr.tween(velTarget, { h: art.velum.height ?? (art.velum.raised ? 1 : 0) }, duration, (tgt) => {
      vocalTract.setVelumHeight(tgt.h);
    });
  }

  // Animate jaw
  if (art.jaw) {
    const jawTarget = { o: vocalTract.currentJawOpen };
    tweenMgr.tween(jawTarget, { o: art.jaw.openness }, duration, (tgt) => {
      vocalTract.setJawOpenness(tgt.o);
    });
  }

  // Set voicing
  vocalTract.setVoicing(art.vocal_folds?.vibrating ?? false);

  // Update airflow if visible
  if (state.airflowVisible) {
    updateAirflow(sound);
  }

  state.isPlaying = true;
  updatePlayButton();
}

// ============================================
// AIRFLOW VISUALIZATION
// ============================================
let airflowParticles = null;
let airflowPositions = [];
let airflowVelocities = [];
const PARTICLE_COUNT = 60;

function createAirflowSystem() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.04,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });

  airflowParticles = new THREE.Points(geometry, material);
  airflowParticles.visible = false;
  scene.add(airflowParticles);

  airflowPositions = new Array(PARTICLE_COUNT).fill(null).map(() => ({ x: 0, y: 0, z: 0, active: false }));
  airflowVelocities = new Array(PARTICLE_COUNT).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
}
createAirflowSystem();

function updateAirflow(sound) {
  if (!airflowParticles || !sound) return;
  const af = sound.airflow;
  if (!af) return;

  airflowParticles.visible = state.airflowVisible;

  // Reset particles
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    airflowPositions[i].active = true;
    // Start near larynx
    airflowPositions[i].x = -0.4 + Math.random() * 0.1;
    airflowPositions[i].y = -0.7 + Math.random() * 0.1;
    airflowPositions[i].z = (Math.random() - 0.5) * 0.2;

    const isNasal = af.path === 'nasal' || (af.path === 'both' && i > PARTICLE_COUNT / 2);

    if (isNasal) {
      airflowVelocities[i] = { x: 0.2 + Math.random() * 0.3, y: 0.8 + Math.random() * 0.3, z: 0 };
    } else {
      airflowVelocities[i] = { x: 0.8 + Math.random() * 0.5, y: 0.2 + Math.random() * 0.2, z: 0 };
    }

    // Add turbulence for fricatives
    if (af.type === 'fricative') {
      airflowVelocities[i].x += (Math.random() - 0.5) * 0.4;
      airflowVelocities[i].y += (Math.random() - 0.5) * 0.4;
    }
  }
}

function animateAirflow(dt) {
  if (!airflowParticles || !airflowParticles.visible) return;

  const positions = airflowParticles.geometry.attributes.position.array;
  const colors = airflowParticles.geometry.attributes.color.array;
  const sound = state.currentSound;
  const isFricative = sound?.airflow?.type === 'fricative';

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = airflowPositions[i];
    const v = airflowVelocities[i];
    if (!p.active) continue;

    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    // Add some randomness
    if (isFricative) {
      p.x += (Math.random() - 0.5) * dt * 0.5;
      p.y += (Math.random() - 0.5) * dt * 0.5;
    }

    // Reset if out of bounds
    if (p.x > 2.5 || p.y > 1.5 || p.y < -1.2) {
      p.x = -0.4 + Math.random() * 0.1;
      p.y = -0.7 + Math.random() * 0.1;
      p.z = (Math.random() - 0.5) * 0.2;
    }

    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;

    // Color: blue for laminar, orange for turbulent
    if (isFricative && Math.random() < 0.3) {
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.72; colors[i * 3 + 2] = 0.3;
    } else {
      colors[i * 3] = 0.39; colors[i * 3 + 1] = 0.71; colors[i * 3 + 2] = 0.96;
    }
  }

  airflowParticles.geometry.attributes.position.needsUpdate = true;
  airflowParticles.geometry.attributes.color.needsUpdate = true;
}

// ============================================
// BUILD IPA CONSONANT CHART
// ============================================
function buildConsonantChart() {
  const container = document.getElementById('consonant-chart');
  container.innerHTML = '';

  // Header row
  const headerRow = document.createElement('div');
  headerRow.className = 'chart-header-row';
  const emptyHeader = document.createElement('div');
  emptyHeader.className = 'chart-header-cell manner-label';
  headerRow.appendChild(emptyHeader);

  for (const place of IPA_DATA.places) {
    const cell = document.createElement('div');
    cell.className = 'chart-header-cell';
    cell.textContent = place.slice(0, 5);
    cell.title = place;
    headerRow.appendChild(cell);
  }
  container.appendChild(headerRow);

  // Data rows
  for (const manner of IPA_DATA.manners) {
    const row = document.createElement('div');
    row.className = 'chart-row';

    const label = document.createElement('div');
    label.className = 'chart-row-label';
    label.textContent = manner.replace('_', ' ');
    row.appendChild(label);

    for (const place of IPA_DATA.places) {
      const cell = document.createElement('div');
      cell.className = 'chart-cell';

      // Find voiceless and voiced sounds for this cell
      const voiceless = Object.values(IPA_DATA.sounds).find(s =>
        s.type === 'consonant' && s.place === place && s.manner === manner && !s.voiced
      );
      const voiced = Object.values(IPA_DATA.sounds).find(s =>
        s.type === 'consonant' && s.place === place && s.manner === manner && s.voiced
      );

      if (voiceless) {
        const btn = createIPAButton(voiceless.symbol);
        cell.appendChild(btn);
      } else {
        const empty = document.createElement('button');
        empty.className = 'ipa-btn empty';
        empty.disabled = true;
        cell.appendChild(empty);
      }

      if (voiced) {
        const btn = createIPAButton(voiced.symbol);
        cell.appendChild(btn);
      } else {
        const empty = document.createElement('button');
        empty.className = 'ipa-btn empty';
        empty.disabled = true;
        cell.appendChild(empty);
      }

      row.appendChild(cell);
    }
    container.appendChild(row);
  }
}

// ============================================
// BUILD VOWEL QUADRILATERAL
// ============================================
function buildVowelChart() {
  const container = document.getElementById('vowel-chart');
  container.innerHTML = '';

  const quad = document.createElement('div');
  quad.className = 'vowel-quadrilateral';

  // SVG trapezoid outline
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';

  // Trapezoid lines
  const lines = [
    [10, 5, 90, 5],   // close
    [15, 35, 85, 35],  // close-mid
    [20, 60, 80, 60],  // open-mid
    [30, 90, 80, 90],  // open
    [10, 5, 30, 90],   // front
    [50, 5, 50, 90],   // central
    [90, 5, 80, 90],   // back
  ];
  for (const [x1, y1, x2, y2] of lines) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', 'var(--border)');
    line.setAttribute('stroke-width', '0.5');
    svg.appendChild(line);
  }

  // Labels
  const labels = [
    { text: 'Close', x: 2, y: 7 },
    { text: 'Close-mid', x: 2, y: 37 },
    { text: 'Open-mid', x: 2, y: 62 },
    { text: 'Open', x: 2, y: 92 },
    { text: 'Front', x: 10, y: 0 },
    { text: 'Central', x: 45, y: 0 },
    { text: 'Back', x: 85, y: 0 },
  ];
  for (const lab of labels) {
    const t = document.createElementNS(svgNS, 'text');
    t.setAttribute('x', lab.x); t.setAttribute('y', lab.y);
    t.setAttribute('fill', 'var(--text-muted)');
    t.setAttribute('font-size', '3.5');
    t.setAttribute('font-family', 'Inter, sans-serif');
    t.textContent = lab.text;
    svg.appendChild(t);
  }

  quad.appendChild(svg);

  // Vowel buttons
  for (const [symbol, pos] of Object.entries(IPA_DATA.vowelPositions)) {
    const sound = IPA_DATA.sounds[symbol];
    if (!sound) continue;

    const btn = document.createElement('button');
    btn.className = 'vowel-btn';
    btn.textContent = symbol;
    btn.dataset.symbol = symbol;
    btn.title = sound.name;
    btn.style.left = pos.x + '%';
    btn.style.top = pos.y + '%';
    btn.addEventListener('click', () => selectSound(symbol));
    quad.appendChild(btn);
  }

  container.appendChild(quad);
}

// ============================================
// BUILD OTHER SOUNDS TAB
// ============================================
function buildOtherChart() {
  const container = document.getElementById('other-chart');
  container.innerHTML = '';

  const sections = [
    { title: 'Affricates', symbols: ['t͡ʃ', 'd͡ʒ', 't͡s', 'd͡z', 't͡ɕ', 'd͡ʑ'] },
    { title: 'Co-articulated', symbols: ['w', 'ɥ'] },
    { title: 'Clicks', symbols: ['ʘ', 'ǀ', 'ǃ', 'ǂ', 'ǁ'] },
    { title: 'Implosives', symbols: ['ɓ', 'ɗ', 'ʄ', 'ɠ', 'ʛ'] },
    { title: 'Ejectives', symbols: ['pʼ', 'tʼ', 'kʼ', 'sʼ'] },
  ];

  for (const section of sections) {
    const div = document.createElement('div');
    div.className = 'other-section';
    const h4 = document.createElement('h4');
    h4.textContent = section.title;
    div.appendChild(h4);

    const grid = document.createElement('div');
    grid.className = 'other-grid';
    for (const sym of section.symbols) {
      if (IPA_DATA.sounds[sym]) {
        grid.appendChild(createIPAButton(sym));
      }
    }
    div.appendChild(grid);
    container.appendChild(div);
  }
}

function createIPAButton(symbol) {
  const btn = document.createElement('button');
  btn.className = 'ipa-btn';
  btn.textContent = symbol;
  btn.dataset.symbol = symbol;
  btn.title = IPA_DATA.sounds[symbol]?.name || symbol;
  btn.addEventListener('click', () => selectSound(symbol));
  return btn;
}

// ============================================
// SEARCH
// ============================================
document.getElementById('ipa-search').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  document.querySelectorAll('.ipa-btn, .vowel-btn').forEach(btn => {
    if (!query) {
      btn.classList.remove('search-match', 'search-hidden');
      return;
    }
    const sym = btn.dataset.symbol;
    const sound = IPA_DATA.sounds[sym];
    if (!sound) {
      btn.classList.add('search-hidden');
      btn.classList.remove('search-match');
      return;
    }
    const searchable = `${sound.symbol} ${sound.name} ${sound.place} ${sound.manner}`.toLowerCase();
    if (searchable.includes(query)) {
      btn.classList.add('search-match');
      btn.classList.remove('search-hidden');
    } else {
      btn.classList.add('search-hidden');
      btn.classList.remove('search-match');
    }
  });
});

// ============================================
// TAB SWITCHING
// ============================================
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ============================================
// RECENT SOUNDS
// ============================================
function addToRecent(symbol) {
  state.recentSounds = state.recentSounds.filter(s => s !== symbol);
  state.recentSounds.unshift(symbol);
  if (state.recentSounds.length > 10) state.recentSounds.pop();

  const container = document.getElementById('recent-list');
  container.innerHTML = '';
  for (const sym of state.recentSounds) {
    const btn = document.createElement('button');
    btn.className = 'recent-btn';
    btn.textContent = sym;
    btn.addEventListener('click', () => selectSound(sym));
    container.appendChild(btn);
  }
}

// ============================================
// INFO PANEL
// ============================================
document.getElementById('info-toggle').addEventListener('click', () => {
  state.infoPanelOpen = !state.infoPanelOpen;
  document.getElementById('info-panel').classList.toggle('expanded', state.infoPanelOpen);
});

function updateInfoPanel(sound) {
  document.getElementById('info-symbol').textContent = sound.symbol;
  document.getElementById('info-name').textContent = sound.name;
  document.getElementById('info-place').textContent = sound.place;
  document.getElementById('info-manner').textContent = sound.manner;
  document.getElementById('info-voicing').textContent = sound.voiced ? 'Voiced' : 'Voiceless';

  // Examples
  const exDiv = document.getElementById('examples-content');
  exDiv.innerHTML = '';
  if (sound.examples) {
    const langNames = { en:'EN', fr:'FR', de:'DE', es:'ES', it:'IT', ja:'JA', zh:'ZH', ar:'AR', hi:'HI', ru:'RU', pt:'PT', ko:'KO', hu:'HU', cz:'CZ', pl:'PL', sv:'SV', no:'NO', fi:'FI', nl:'NL', ro:'RO', tr:'TR', he:'HE', sw:'SW', ha:'HA', zu:'ZU', xh:'XH', cy:'CY', sco:'SCO', gr:'GR', am:'AM', ka:'KA', ur:'UR' };
    for (const [lang, words] of Object.entries(sound.examples)) {
      if (words.length === 0) continue;
      const row = document.createElement('div');
      row.className = 'example-lang';
      const code = document.createElement('span');
      code.className = 'example-lang-code';
      code.textContent = langNames[lang] || lang.toUpperCase();
      const w = document.createElement('span');
      w.className = 'example-words';
      w.textContent = words.join(', ');
      row.appendChild(code);
      row.appendChild(w);
      exDiv.appendChild(row);
    }
  }

  // Coaching notes
  document.getElementById('coaching-content').textContent = sound.coaching_notes || '';

  // Similar sounds
  const simDiv = document.getElementById('similar-sounds');
  simDiv.innerHTML = '';
  if (sound.similar_sounds) {
    for (const sym of sound.similar_sounds) {
      const btn = document.createElement('button');
      btn.className = 'similar-btn';
      btn.textContent = sym;
      btn.addEventListener('click', () => selectSound(sym));
      simDiv.appendChild(btn);
    }
  }
}

// ============================================
// COMPARISON MODE
// ============================================
document.getElementById('btn-compare').addEventListener('click', () => {
  state.compareMode = !state.compareMode;
  document.getElementById('btn-compare').classList.toggle('active', state.compareMode);
  document.getElementById('comparison-overlay').style.display = state.compareMode ? 'block' : 'none';
  if (!state.compareMode) {
    state.compareSound1 = null;
    state.compareSound2 = null;
    state.compareSlot = 1;
    document.getElementById('compare-symbol-1').textContent = '—';
    document.getElementById('compare-symbol-2').textContent = '—';
    document.getElementById('comparison-diff').textContent = '';
    document.getElementById('compare-slot-1').classList.remove('filled');
    document.getElementById('compare-slot-2').classList.remove('filled');
  }
});

document.getElementById('exit-compare').addEventListener('click', () => {
  state.compareMode = false;
  document.getElementById('btn-compare').classList.remove('active');
  document.getElementById('comparison-overlay').style.display = 'none';
});

function handleCompareSelect(sound) {
  if (state.compareSlot === 1) {
    state.compareSound1 = sound;
    document.getElementById('compare-symbol-1').textContent = sound.symbol;
    document.getElementById('compare-slot-1').classList.add('filled');
    state.compareSlot = 2;
    animateToSound(sound);
  } else {
    state.compareSound2 = sound;
    document.getElementById('compare-symbol-2').textContent = sound.symbol;
    document.getElementById('compare-slot-2').classList.add('filled');
    state.compareSlot = 1;
    animateToSound(sound);
    generateComparisonDiff();
  }
}

function generateComparisonDiff() {
  const s1 = state.compareSound1;
  const s2 = state.compareSound2;
  if (!s1 || !s2) return;

  const diffs = [];
  if (s1.place !== s2.place) diffs.push(`Place: ${s1.place} \u2192 ${s2.place}`);
  if (s1.manner !== s2.manner) diffs.push(`Manner: ${s1.manner} \u2192 ${s2.manner}`);
  if (s1.voiced !== s2.voiced) diffs.push(`Voicing: ${s1.voiced ? 'voiced' : 'voiceless'} \u2192 ${s2.voiced ? 'voiced' : 'voiceless'}`);

  const a1 = s1.articulators, a2 = s2.articulators;
  if (a1.velum?.raised !== a2.velum?.raised) {
    diffs.push(`Velum: ${a1.velum?.raised ? 'raised' : 'lowered'} \u2192 ${a2.velum?.raised ? 'raised' : 'lowered'}`);
  }
  if (Math.abs((a1.lips?.rounding || 0) - (a2.lips?.rounding || 0)) > 0.2) {
    diffs.push(`Lips: ${a1.lips?.rounding > 0.3 ? 'rounded' : 'spread'} \u2192 ${a2.lips?.rounding > 0.3 ? 'rounded' : 'spread'}`);
  }

  document.getElementById('comparison-diff').textContent = diffs.join('\n') || 'Very similar articulations';
}

// ============================================
// PLAYBACK CONTROLS
// ============================================
const btnPlay = document.getElementById('btn-play');
const iconPlay = btnPlay.querySelector('.icon-play');
const iconPause = btnPlay.querySelector('.icon-pause');

function updatePlayButton() {
  iconPlay.style.display = state.isPlaying ? 'none' : 'block';
  iconPause.style.display = state.isPlaying ? 'block' : 'none';
}

btnPlay.addEventListener('click', () => {
  if (state.isPlaying) {
    state.isPlaying = false;
    tweenMgr.cancel();
  } else if (state.currentSound) {
    animateToSound(state.currentSound);
  }
  updatePlayButton();
});

document.getElementById('btn-loop').addEventListener('click', () => {
  state.looping = !state.looping;
  document.getElementById('btn-loop').classList.toggle('active', state.looping);
});

document.getElementById('speed-select').addEventListener('change', (e) => {
  state.speed = parseFloat(e.target.value);
});

document.getElementById('btn-prev').addEventListener('click', () => {
  // Step backward by resetting to neutral
  vocalTract.resetToNeutral();
});

document.getElementById('btn-next').addEventListener('click', () => {
  // Step forward by jumping to target
  if (state.currentSound) {
    tweenMgr.cancel();
    const art = state.currentSound.articulators;
    {
      const isVowel = state.currentSound.type === 'vowel';
      vocalTract.setTonguePosition({
        tip: (art.tongue_tip && !isVowel) ? { x: art.tongue_tip.x, y: art.tongue_tip.y, contact: !!art.tongue_tip.contact } : undefined,
        blade: (art.tongue_blade && !isVowel) ? { x: art.tongue_blade.x, y: art.tongue_blade.y } : undefined,
        body: art.tongue_body || { height: 0.45, frontness: 0.50 },
        root: art.tongue_root,
      });
    }
    if (art.lips) vocalTract.setLipShape(art.lips);
    if (art.velum) vocalTract.setVelumHeight(art.velum.height ?? (art.velum.raised ? 1 : 0));
    if (art.jaw) vocalTract.setJawOpenness(art.jaw.openness);
    vocalTract.setVoicing(art.vocal_folds?.vibrating ?? false);
  }
});

// ============================================
// ANATOMICAL LABELS
// ============================================
let labelElements = {};

function createLabels() {
  const positions = vocalTract.getArticulatorPositions();
  for (const [name, pos] of Object.entries(positions)) {
    const el = document.createElement('div');
    el.className = 'articulator-label';
    el.textContent = name;
    viewport.appendChild(el);
    labelElements[name] = { el, pos3D: pos };
  }
}

function updateLabels() {
  if (!state.labelsVisible) {
    for (const lab of Object.values(labelElements)) lab.el.style.display = 'none';
    return;
  }

  const positions = vocalTract.getArticulatorPositions();
  for (const [name, data] of Object.entries(labelElements)) {
    const pos3D = positions[name] || data.pos3D;
    const screenPos = pos3D.clone().project(camera);
    const x = (screenPos.x * 0.5 + 0.5) * viewport.clientWidth;
    const y = (-screenPos.y * 0.5 + 0.5) * viewport.clientHeight;

    if (screenPos.z < 1 && x > 0 && x < viewport.clientWidth && y > 0 && y < viewport.clientHeight) {
      data.el.style.display = 'block';
      data.el.style.left = x + 'px';
      data.el.style.top = y + 'px';
    } else {
      data.el.style.display = 'none';
    }
  }
}

document.getElementById('btn-labels').addEventListener('click', () => {
  state.labelsVisible = !state.labelsVisible;
  document.getElementById('btn-labels').classList.toggle('active', state.labelsVisible);
  updateLabels();
});

// ============================================
// AIRFLOW TOGGLE
// ============================================
document.getElementById('btn-airflow').addEventListener('click', () => {
  state.airflowVisible = !state.airflowVisible;
  document.getElementById('btn-airflow').classList.toggle('active', state.airflowVisible);
  if (airflowParticles) airflowParticles.visible = state.airflowVisible;
  if (state.airflowVisible && state.currentSound) {
    updateAirflow(state.currentSound);
  }
});

// (Skin toggle removed — skin always visible)

// ============================================
// CROSS-SECTION TOGGLE
// ============================================
let crossSectionMode = false;
document.getElementById('btn-cross-section')?.addEventListener('click', () => {
  crossSectionMode = !crossSectionMode;
  vocalTract.setViewMode(crossSectionMode ? 'crossSection' : '3d');
  renderer.localClippingEnabled = crossSectionMode;
  document.getElementById('btn-cross-section')?.classList.toggle('active', crossSectionMode);
});

// ============================================
// PLAY SOUND BUTTON
// ============================================
document.getElementById('btn-play-sound').addEventListener('click', () => {
  playCurrentSound();
});

// ============================================
// MUTE TOGGLE
// ============================================
document.getElementById('btn-mute').addEventListener('click', () => {
  state.muted = !state.muted;
  const btnMute = document.getElementById('btn-mute');
  btnMute.querySelector('.icon-unmuted').style.display = state.muted ? 'none' : 'block';
  btnMute.querySelector('.icon-muted').style.display = state.muted ? 'block' : 'none';
  btnMute.classList.toggle('active', state.muted);
});

// ============================================
// ADJUST PANEL (Manual slider controls)
// ============================================
let adjustPanelOpen = false;

document.getElementById('btn-adjust').addEventListener('click', () => {
  adjustPanelOpen = !adjustPanelOpen;
  document.getElementById('btn-adjust').classList.toggle('active', adjustPanelOpen);
  document.getElementById('adjust-panel').classList.toggle('expanded', adjustPanelOpen);
});

// Reset button — restore sliders to current sound
document.getElementById('adjust-reset').addEventListener('click', () => {
  if (state.currentSound) {
    updateSlidersFromSound(state.currentSound);
  }
});

// Read sliders and apply tongue position
function applyTongueFromSliders() {
  const height = parseFloat(document.getElementById('sl-body-height').value);
  const frontness = parseFloat(document.getElementById('sl-body-front').value);
  const tipX = parseFloat(document.getElementById('sl-tip-x').value);
  const tipY = parseFloat(document.getElementById('sl-tip-y').value);
  const rootAdv = parseFloat(document.getElementById('sl-root-adv').value);

  const params = {
    body: { height, frontness },
    root: { advancement: rootAdv },
  };

  // Only pass tip if the user has moved the sliders from default vowel position.
  // For vowels, tip is auto-derived from body — explicit tip overrides that.
  const tipDefault = tipX === 0.5 && tipY === 0.35;
  if (!tipDefault) {
    params.tip = { x: tipX, y: tipY };
  }

  vocalTract.setTonguePosition(params);
}

// Apply lip sliders
function applyLipsFromSliders() {
  vocalTract.setLipShape({
    rounding: parseFloat(document.getElementById('sl-lip-round').value),
    openness: parseFloat(document.getElementById('sl-lip-open').value),
    protrusion: parseFloat(document.getElementById('sl-lip-prot').value),
    spread: parseFloat(document.getElementById('sl-lip-spread').value),
  });
}

// Slider input handlers — real-time updates
const sliderHandlers = {
  'sl-body-height': { val: 'sv-body-height', apply: applyTongueFromSliders },
  'sl-body-front':  { val: 'sv-body-front',  apply: applyTongueFromSliders },
  'sl-tip-x':       { val: 'sv-tip-x',       apply: applyTongueFromSliders },
  'sl-tip-y':       { val: 'sv-tip-y',        apply: applyTongueFromSliders },
  'sl-root-adv':    { val: 'sv-root-adv',     apply: applyTongueFromSliders },
  'sl-lip-round':   { val: 'sv-lip-round',    apply: applyLipsFromSliders },
  'sl-lip-open':    { val: 'sv-lip-open',     apply: applyLipsFromSliders },
  'sl-lip-prot':    { val: 'sv-lip-prot',     apply: applyLipsFromSliders },
  'sl-lip-spread':  { val: 'sv-lip-spread',   apply: applyLipsFromSliders },
  'sl-jaw':         { val: 'sv-jaw',          apply: () => vocalTract.setJawOpenness(parseFloat(document.getElementById('sl-jaw').value)) },
  'sl-velum':       { val: 'sv-velum',        apply: () => vocalTract.setVelumHeight(parseFloat(document.getElementById('sl-velum').value)) },
};

for (const [sliderId, handler] of Object.entries(sliderHandlers)) {
  document.getElementById(sliderId).addEventListener('input', () => {
    const val = parseFloat(document.getElementById(sliderId).value);
    document.getElementById(handler.val).textContent = val.toFixed(2);
    handler.apply();
  });
}

// Update sliders to reflect a sound's articulators
function updateSlidersFromSound(sound) {
  const art = sound.articulators;

  // Tongue body
  const bodyH = art.tongue_body?.height ?? 0.5;
  const bodyF = art.tongue_body?.frontness ?? 0.5;
  setSlider('sl-body-height', bodyH);
  setSlider('sl-body-front', bodyF);

  // Tongue tip — defaults if not specified (vowels)
  const isVowel = sound.type === 'vowel';
  setSlider('sl-tip-x', (!isVowel && art.tongue_tip) ? art.tongue_tip.x : 0.5);
  setSlider('sl-tip-y', (!isVowel && art.tongue_tip) ? art.tongue_tip.y : 0.35);

  // Tongue root
  setSlider('sl-root-adv', art.tongue_root?.advancement ?? 0.5);

  // Lips
  setSlider('sl-lip-round', art.lips?.rounding ?? 0.1);
  setSlider('sl-lip-open', art.lips?.openness ?? 0.3);
  setSlider('sl-lip-prot', art.lips?.protrusion ?? 0);
  setSlider('sl-lip-spread', art.lips?.spread ?? 0.5);

  // Jaw, Velum
  setSlider('sl-jaw', art.jaw?.openness ?? 0.2);
  setSlider('sl-velum', art.velum?.height ?? (art.velum?.raised ? 1 : 0));
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  const valId = id.replace('sl-', 'sv-');
  document.getElementById(valId).textContent = parseFloat(value).toFixed(2);
}

// ============================================
// DARK/LIGHT MODE
// ============================================
document.getElementById('btn-theme').addEventListener('click', () => {
  state.darkMode = !state.darkMode;
  document.body.classList.toggle('dark-mode', state.darkMode);
  document.body.classList.toggle('light-mode', !state.darkMode);
  renderer.setClearColor(state.darkMode ? 0x0B1221 : 0xf5f0ea);
});

// ============================================
// ABOUT MODAL
// ============================================
document.getElementById('btn-about').addEventListener('click', () => {
  document.getElementById('about-modal').style.display = 'flex';
});

document.getElementById('about-close').addEventListener('click', () => {
  document.getElementById('about-modal').style.display = 'none';
});

document.getElementById('about-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('about-modal').style.display = 'none';
  }
});

// ============================================
// DRAGGABLE ARTICULATOR HANDLES
// ============================================
const HANDLE_CONFIG = {
  body:  { color: 0xe8a040, radius: 0.055 },  // gold — tongue body
  tip:   { color: 0xe06060, radius: 0.055 },  // red — tongue tip
  root:  { color: 0x8060c0, radius: 0.050 },  // purple — tongue root
  lips:  { color: 0xc46868, radius: 0.060 },  // pink — lips
  jaw:   { color: 0x90a0b0, radius: 0.055 },  // gray — jaw
  velum: { color: 0xc490b0, radius: 0.050 },  // mauve — velum
};

const handleMeshes = {};
// Invisible hit-test spheres (larger) used for proximity hover detection
const handleHitMeshes = {};
for (const [key, cfg] of Object.entries(HANDLE_CONFIG)) {
  // Visible handle (shown only on hover/drag)
  const geo = new THREE.SphereGeometry(cfg.radius, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.85, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;  // hidden by default — shown on hover
  mesh.renderOrder = 999;
  mesh.userData.handleKey = key;
  mesh.userData.baseOpacity = 0.85;
  scene.add(mesh);
  handleMeshes[key] = mesh;

  // Invisible hit-target (3x larger for easy hover detection)
  const hitGeo = new THREE.SphereGeometry(cfg.radius * 3.0, 8, 8);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitMesh = new THREE.Mesh(hitGeo, hitMat);
  hitMesh.userData.handleKey = key;
  hitMesh.raycast = THREE.Mesh.prototype.raycast; // ensure raycasting works even though invisible
  scene.add(hitMesh);
  handleHitMeshes[key] = hitMesh;
}

// Position all handles based on current articulator state
const _velumHandlePos = new THREE.Vector3();
function updateHandlePositions() {
  const t = vocalTract.currentTongue;
  if (!t) return;
  // Tongue handles — offset up slightly so they sit on top of the surface
  handleMeshes.body.position.set(t.body.x, t.body.y + 0.14, 0);
  handleMeshes.tip.position.set(t.tip.x, t.tip.y + 0.05, 0);
  handleMeshes.root.position.set(t.root.x, t.root.y, 0);
  // Lips — at lip center, accounting for jaw drop
  const prot = vocalTract.currentLips.protrusion;
  const jawDrop = vocalTract.currentJawOpen * 0.28;
  handleMeshes.lips.position.set(1.30 + prot * 0.12, 0.40 - jawDrop * 0.3, 0);
  // Jaw — at front-center of jaw
  handleMeshes.jaw.position.set(0.80, 0.05 - jawDrop, 0);
  // Velum — track rotation via localToWorld
  _velumHandlePos.set(-0.38, 0.51, 0);
  if (vocalTract.velumGroup) {
    vocalTract.velumGroup.localToWorld(_velumHandlePos);
    _velumHandlePos.z = 0;
  }
  handleMeshes.velum.position.copy(_velumHandlePos);
  // Sync hit-test spheres to same positions
  for (const key of Object.keys(handleMeshes)) {
    handleHitMeshes[key].position.copy(handleMeshes[key].position);
  }
}

// Raycasting for drag & hover interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let dragHandle = null;
let activeDragPlane = null;
let dragIntersection = new THREE.Vector3();
let hoveredHandle = null;

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function getPointerNDC(e) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

function getDragPlane(handlePos) {
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const plane = new THREE.Plane();
  plane.setFromNormalAndCoplanarPoint(camDir, handlePos);
  return plane;
}

function onHandlePointerDown(e) {
  getPointerNDC(e);
  raycaster.setFromCamera(mouse, camera);
  // Raycast against invisible hit spheres for larger click target
  const hits = raycaster.intersectObjects(Object.values(handleHitMeshes));
  if (hits.length > 0) {
    const key = hits[0].object.userData.handleKey;
    dragHandle = handleMeshes[key];
    dragHandle.visible = true;
    dragHandle.material.opacity = 1.0;
    dragHandle.scale.setScalar(1.4);
    canvas.style.cursor = 'grabbing';
    controls.enabled = false;
    activeDragPlane = getDragPlane(dragHandle.position);
    e.preventDefault();
  }
}

function onHandlePointerMove(e) {
  // Hover detection (when not dragging)
  if (!dragHandle) {
    getPointerNDC(e);
    raycaster.setFromCamera(mouse, camera);
    // Raycast against invisible hit spheres for proximity hover
    const hits = raycaster.intersectObjects(Object.values(handleHitMeshes));
    const hitKey = hits.length > 0 ? hits[0].object.userData.handleKey : null;
    const newHover = hitKey ? handleMeshes[hitKey] : null;
    if (newHover !== hoveredHandle) {
      if (hoveredHandle) {
        hoveredHandle.visible = false;  // hide when mouse leaves
        hoveredHandle.scale.setScalar(1.0);
      }
      if (newHover) {
        newHover.visible = true;  // show on hover
        newHover.material.opacity = 1.0;
        newHover.scale.setScalar(1.15);
        canvas.style.cursor = 'grab';
      } else {
        canvas.style.cursor = '';
      }
      hoveredHandle = newHover;
    }
    return;
  }

  // Drag logic
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (!raycaster.ray.intersectPlane(activeDragPlane, dragIntersection)) return;

  const key = dragHandle.userData.handleKey;

  if (key === 'body') {
    const f = clamp01((dragIntersection.x + 0.35) / 0.85);
    const h = clamp01((dragIntersection.y + 0.25) / 0.78);
    setSlider('sl-body-height', h);
    setSlider('sl-body-front', f);
    applyTongueFromSliders();
  } else if (key === 'tip') {
    const px = clamp01((dragIntersection.x + 0.10) / 1.25);
    const py = clamp01((dragIntersection.y + 0.15) / 0.66);
    setSlider('sl-tip-x', px);
    setSlider('sl-tip-y', py);
    applyTongueFromSliders();
  } else if (key === 'root') {
    const adv = clamp01((dragIntersection.x + 0.58) / 0.25);
    setSlider('sl-root-adv', adv);
    applyTongueFromSliders();
  } else if (key === 'lips') {
    const prot = clamp01((dragIntersection.x - 1.30) / 0.12);
    const open = clamp01((0.50 - dragIntersection.y) / 0.30);
    setSlider('sl-lip-prot', prot);
    setSlider('sl-lip-open', open);
    applyLipsFromSliders();
  } else if (key === 'jaw') {
    const openness = clamp01((0.05 - dragIntersection.y) / 0.28);
    setSlider('sl-jaw', openness);
    vocalTract.setJawOpenness(openness);
  } else if (key === 'velum') {
    const height = clamp01((dragIntersection.y - 0.20) / 0.35);
    setSlider('sl-velum', height);
    vocalTract.setVelumHeight(height);
  }

  e.preventDefault();
}

function onHandlePointerUp() {
  if (dragHandle) {
    dragHandle.scale.setScalar(1.0);
    dragHandle.visible = false;  // hide after releasing
    canvas.style.cursor = '';
    hoveredHandle = null;
    dragHandle = null;
    activeDragPlane = null;
    controls.enabled = true;
  }
}

canvas.addEventListener('pointerdown', onHandlePointerDown);
canvas.addEventListener('pointermove', onHandlePointerMove);
canvas.addEventListener('pointerup', onHandlePointerUp);
canvas.addEventListener('touchstart', onHandlePointerDown, { passive: false });
canvas.addEventListener('touchmove', onHandlePointerMove, { passive: false });
canvas.addEventListener('touchend', onHandlePointerUp);

// ============================================
// RESIZE HANDLER
// ============================================
function onResize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ============================================
// ANIMATION LOOP
// ============================================
const clock = new THREE.Clock();
let loopCooldown = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  // Camera animation
  if (cameraAnimating) {
    cameraT += dt * 2;
    const t = Math.min(cameraT, 1);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(cameraStartPos, cameraEndPos, ease);
    controls.target.lerpVectors(cameraStartTarget, cameraEndTarget, ease);
    if (t >= 1) cameraAnimating = false;
  }

  controls.update();
  tweenMgr.update(dt);
  vocalTract.update(dt);
  animateAirflow(dt);
  updateLabels();
  updateHandlePositions();

  // Loop handling
  if (state.looping && state.currentSound && !tweenMgr.active) {
    loopCooldown += dt;
    if (loopCooldown > 1.5 / state.speed) {
      loopCooldown = 0;
      vocalTract.resetToNeutral();
      setTimeout(() => {
        if (state.looping && state.currentSound) {
          animateToSound(state.currentSound);
        }
      }, 500 / state.speed);
    }
  } else {
    loopCooldown = 0;
  }

  // Update playing state
  if (state.isPlaying && !tweenMgr.active && !state.looping) {
    state.isPlaying = false;
    updatePlayButton();
  }

  renderer.render(scene, camera);
}

// ============================================
// AUDIO PLAYBACK
// ============================================
// IPA audio from University of British Columbia / Wiktionary commons
// Maps IPA symbols to filenames on Wikimedia Commons
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioCache = {};

// Wikimedia Commons IPA audio file naming convention
const LOCAL_AUDIO_DIR = 'sounds/';
const WIKI_AUDIO_BASE = 'https://upload.wikimedia.org/wikipedia/commons/';

// Map IPA symbols to known Wikimedia Commons audio paths
// These are curated paths to actual hosted OGG files
const IPA_AUDIO_MAP = {
  // Plosives
  'p': '5/51/Voiceless_bilabial_plosive.ogg',
  'b': '2/2c/Voiced_bilabial_plosive.ogg',
  't': '0/02/Voiceless_alveolar_plosive.ogg',
  'd': '0/01/Voiced_alveolar_plosive.ogg',
  'ʈ': 'b/b0/Voiceless_retroflex_plosive.ogg',
  'ɖ': '2/27/Voiced_retroflex_stop.oga',
  'c': '5/5d/Voiceless_palatal_plosive.ogg',
  'ɟ': '1/1d/Voiced_palatal_plosive.ogg',
  'k': 'e/e3/Voiceless_velar_plosive.ogg',
  'ɡ': 'b/b4/Voiced_velar_plosive.ogg',
  'q': '1/19/Voiceless_uvular_plosive.ogg',
  'ɢ': 'b/b6/Voiced_uvular_stop.oga',
  'ʔ': '4/4d/Glottal_stop.ogg',

  // Nasals
  'm': 'a/a9/Bilabial_nasal.ogg',
  'ɱ': '1/18/Labiodental_nasal.ogg',
  'n': '2/29/Alveolar_nasal.ogg',
  'ɳ': 'a/af/Retroflex_nasal.ogg',
  'ɲ': '4/46/Palatal_nasal.ogg',
  'ŋ': '3/39/Velar_nasal.ogg',
  'ɴ': '3/3e/Uvular_nasal.ogg',

  // Trills
  'ʙ': 'e/e7/Bilabial_trill.ogg',
  'r': 'c/ce/Alveolar_trill.ogg',
  'ʀ': 'c/cb/Uvular_trill.ogg',

  // Taps
  'ⱱ': '2/2c/Labiodental_flap.ogg',
  'ɾ': 'a/a0/Alveolar_tap.ogg',
  'ɽ': '8/87/Retroflex_flap.ogg',

  // Fricatives
  'ɸ': '4/41/Voiceless_bilabial_fricative.ogg',
  'β': '3/37/Voiced_bilabial_fricative.ogg',
  'f': '3/33/Voiceless_labiodental_fricative.ogg',
  'v': '8/85/Voiced_labiodental_fricative.ogg',
  'θ': '8/80/Voiceless_dental_fricative.ogg',
  'ð': '6/6a/Voiced_dental_fricative.ogg',
  's': 'a/ac/Voiceless_alveolar_sibilant.ogg',
  'z': 'c/c0/Voiced_alveolar_sibilant.ogg',
  'ʃ': 'c/cc/Voiceless_palato-alveolar_sibilant.ogg',
  'ʒ': '3/30/Voiced_palato-alveolar_sibilant.ogg',
  'ʂ': 'b/b1/Voiceless_retroflex_sibilant.ogg',
  'ʐ': '7/7f/Voiced_retroflex_sibilant.ogg',
  'ç': 'a/ab/Voiceless_palatal_fricative.ogg',
  'ʝ': 'a/ac/Voiced_palatal_fricative.ogg',
  'x': '0/0f/Voiceless_velar_fricative.ogg',
  'ɣ': '4/47/Voiced_velar_fricative.ogg',
  'χ': 'c/c8/Voiceless_uvular_fricative.ogg',
  'ʁ': 'a/af/Voiced_uvular_fricative.ogg',
  'ħ': 'b/b2/Voiceless_pharyngeal_fricative.ogg',
  'ʕ': 'c/cd/Voiced_pharyngeal_fricative.ogg',
  'h': 'd/da/Voiceless_glottal_fricative.ogg',
  'ɦ': 'e/e2/Voiced_glottal_fricative.ogg',

  // Lateral fricatives
  'ɬ': 'e/ea/Voiceless_alveolar_lateral_fricative.ogg',
  'ɮ': '6/6f/Voiced_alveolar_lateral_fricative.ogg',

  // Approximants
  'ʋ': 'e/ee/Labiodental_approximant.ogg',
  'ɹ': '1/1f/Alveolar_approximant.ogg',
  'ɻ': 'd/d2/Retroflex_approximant.ogg',
  'j': 'e/e8/Palatal_approximant.ogg',
  'ɰ': '5/5c/Voiced_velar_approximant.ogg',

  // Lateral approximants
  'l': 'b/bc/Alveolar_lateral_approximant.ogg',
  'ɭ': 'd/d1/Retroflex_lateral_approximant.ogg',
  'ʎ': 'd/d9/Palatal_lateral_approximant.ogg',
  'ʟ': 'd/d3/Velar_lateral_approximant.ogg',

  // Co-articulated
  'w': 'f/f2/Voiced_labio-velar_approximant.ogg',
  'ɥ': 'e/ea/Voiced_labial-palatal_approximant.ogg',

  // Vowels
  'i': '9/91/Close_front_unrounded_vowel.ogg',
  'y': 'e/ea/Close_front_rounded_vowel.ogg',
  'ɨ': '5/53/Close_central_unrounded_vowel.ogg',
  'ʉ': '6/66/Close_central_rounded_vowel.ogg',
  'ɯ': 'e/e8/Close_back_unrounded_vowel.ogg',
  'u': '5/5d/Close_back_rounded_vowel.ogg',
  'ɪ': '4/4c/Near-close_near-front_unrounded_vowel.ogg',
  'ʏ': 'e/e3/Near-close_near-front_rounded_vowel.ogg',
  'ʊ': 'd/d5/Near-close_near-back_rounded_vowel.ogg',
  'e': '6/6c/Close-mid_front_unrounded_vowel.ogg',
  'ø': '5/53/Close-mid_front_rounded_vowel.ogg',
  'ɘ': '6/60/Close-mid_central_unrounded_vowel.ogg',
  'ɵ': 'b/b5/Close-mid_central_rounded_vowel.ogg',
  'ɤ': '2/26/Close-mid_back_unrounded_vowel.ogg',
  'o': '8/84/Close-mid_back_rounded_vowel.ogg',
  'ə': 'd/d9/Mid-central_vowel.ogg',
  'ɛ': '7/71/Open-mid_front_unrounded_vowel.ogg',
  'œ': '0/00/Open-mid_front_rounded_vowel.ogg',
  'ɜ': '0/01/Open-mid_central_unrounded_vowel.ogg',
  'ɞ': 'd/d9/Open-mid_central_rounded_vowel.ogg',
  'ʌ': '9/92/Open-mid_back_unrounded_vowel.ogg',
  'ɔ': '0/02/Open-mid_back_rounded_vowel.ogg',
  'æ': 'c/c9/Near-open_front_unrounded_vowel.ogg',
  'ɐ': '2/22/Near-open_central_unrounded_vowel.ogg',
  'a': '0/0e/PR-open_front_unrounded_vowel.ogg',
  'ɶ': 'c/c1/Open_front_rounded_vowel.ogg',
  'ɑ': 'e/e5/Open_back_unrounded_vowel.ogg',
  'ɒ': '3/31/PR-open_back_rounded_vowel.ogg',
};

async function playIPASound(symbol) {
  // Mute check
  if (state.muted) return false;

  // Resume AudioContext if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const relPath = IPA_AUDIO_MAP[symbol];
  if (!relPath) {
    // No audio available for this symbol
    return false;
  }

  // Extract filename from Wikimedia path (e.g. '5/51/Voiceless_bilabial_plosive.ogg' → 'Voiceless_bilabial_plosive.ogg')
  const filename = relPath.split('/').pop();
  const localUrl = LOCAL_AUDIO_DIR + filename;
  const wikiUrl = WIKI_AUDIO_BASE + relPath;

  try {
    let buffer = audioCache[symbol];
    if (!buffer) {
      // Try local bundled audio first, fall back to Wikimedia
      let response;
      try {
        response = await fetch(localUrl);
        if (!response.ok) throw new Error('local not found');
      } catch (_) {
        response = await fetch(wikiUrl);
        if (!response.ok) return false;
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCache[symbol] = buffer;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(0);
    return true;
  } catch (e) {
    console.warn('Audio playback failed for', symbol, e);
    return false;
  }
}

// Add audio playback to sound selection
function playCurrentSound() {
  if (state.currentSound) {
    playIPASound(state.currentSound.symbol);
  }
}

// ============================================
// ACCENTS & DIALECTS (hidden feature — triple-click logo to reveal)
// ============================================

let activeAccentId = null;

function getDifficultyInfo(level) {
  const labels = ['Reference', 'Easy', 'Moderate', 'Challenging', 'Advanced', 'Expert'];
  const colors = ['#7a8290', '#64b478', '#b89d65', '#d4a04a', '#d47840', '#e06060'];
  return { label: labels[level] || 'Unknown', color: colors[level] || '#7a8290', dots: level };
}

function buildAccentGrid() {
  const container = document.getElementById('accent-grid');
  if (!container || typeof ACCENT_DATA === 'undefined') return;
  container.innerHTML = '';

  for (const [id, accent] of Object.entries(ACCENT_DATA.accents)) {
    const card = document.createElement('div');
    card.className = 'accent-card';
    card.dataset.accentId = id;

    // Header row with name and difficulty
    const headerRow = document.createElement('div');
    headerRow.className = 'accent-card-header';

    const name = document.createElement('h3');
    name.className = 'accent-card-name';
    name.textContent = accent.name;
    headerRow.appendChild(name);

    if (accent.difficulty > 0) {
      const diff = getDifficultyInfo(accent.difficulty);
      const badge = document.createElement('span');
      badge.className = 'accent-card-difficulty';
      badge.style.color = diff.color;
      badge.textContent = '\u25CF'.repeat(diff.dots) + '\u25CB'.repeat(5 - diff.dots);
      badge.title = diff.label;
      headerRow.appendChild(badge);
    } else {
      const refBadge = document.createElement('span');
      refBadge.className = 'accent-card-ref-badge';
      refBadge.textContent = 'REF';
      headerRow.appendChild(refBadge);
    }
    card.appendChild(headerRow);

    const region = document.createElement('p');
    region.className = 'accent-card-region';
    region.textContent = accent.region;
    card.appendChild(region);

    // Short description preview
    const desc = document.createElement('p');
    desc.className = 'accent-card-desc';
    desc.textContent = accent.description.length > 120 ? accent.description.substring(0, 120) + '...' : accent.description;
    card.appendChild(desc);

    const tags = document.createElement('div');
    tags.className = 'accent-card-tags';
    accent.keyFeatures.slice(0, 3).forEach(f => {
      const tag = document.createElement('span');
      tag.className = 'accent-tag';
      tag.textContent = f.label;
      tags.appendChild(tag);
    });
    card.appendChild(tags);

    // Stats row
    const stats = document.createElement('div');
    stats.className = 'accent-card-stats';
    const lexCount = accent.lexicalSets ? Object.keys(accent.lexicalSets).length : 0;
    const exerciseCount = accent.exercises ? accent.exercises.length : 0;
    stats.innerHTML = `<span>${lexCount} lexical sets</span><span>${exerciseCount} exercise${exerciseCount !== 1 ? 's' : ''}</span>`;
    card.appendChild(stats);

    card.addEventListener('click', () => showAccentDetail(id));
    container.appendChild(card);
  }
}

function showAccentDetail(accentId) {
  const accent = ACCENT_DATA.accents[accentId];
  if (!accent) return;
  activeAccentId = accentId;

  document.getElementById('accent-grid').style.display = 'none';
  const detailEl = document.getElementById('accent-detail');
  detailEl.style.display = 'block';
  // Scroll to top of detail view
  const backBtn = document.getElementById('accent-back');
  if (backBtn) backBtn.scrollIntoView({ behavior: 'instant' });

  document.getElementById('accent-name').textContent = accent.name;
  document.getElementById('accent-region').textContent = accent.region;
  document.getElementById('accent-description').textContent = accent.description;

  // Difficulty badge
  const diffBadge = document.getElementById('accent-difficulty');
  if (accent.difficulty > 0) {
    const diff = getDifficultyInfo(accent.difficulty);
    diffBadge.textContent = diff.label;
    diffBadge.style.background = diff.color + '22';
    diffBadge.style.color = diff.color;
    diffBadge.style.borderColor = diff.color + '44';
    diffBadge.style.display = '';
  } else {
    diffBadge.textContent = 'Reference';
    diffBadge.style.background = 'rgba(122,130,144,0.15)';
    diffBadge.style.color = '#7a8290';
    diffBadge.style.borderColor = 'rgba(122,130,144,0.3)';
    diffBadge.style.display = '';
  }

  // Key features
  const featEl = document.getElementById('accent-features');
  featEl.innerHTML = '';
  accent.keyFeatures.forEach(f => {
    const div = document.createElement('div');
    div.className = 'accent-feature';
    div.innerHTML = `<span class="accent-feature-label">${f.label}</span><span class="accent-feature-desc">${f.description}</span>`;
    featEl.appendChild(div);
  });

  // === Lexical Sets (Wells) ===
  const lexEl = document.getElementById('accent-lexical-sets');
  lexEl.innerHTML = '';
  if (accent.lexicalSets) {
    const lexGroups = [
      { title: 'Short Vowels', sets: ['KIT', 'DRESS', 'TRAP', 'LOT', 'STRUT', 'FOOT'] },
      { title: 'Long Vowels', sets: ['BATH', 'CLOTH', 'NURSE', 'FLEECE', 'PALM', 'THOUGHT', 'GOOSE'] },
      { title: 'Diphthongs', sets: ['FACE', 'GOAT', 'PRICE', 'CHOICE', 'MOUTH'] },
      { title: 'Centering / R-coloured', sets: ['NEAR', 'SQUARE', 'START', 'NORTH', 'FORCE', 'CURE'] },
      { title: 'Weak Vowels', sets: ['happY', 'lettER', 'commA'] },
    ];

    lexGroups.forEach(group => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'lex-group';

      const groupTitle = document.createElement('div');
      groupTitle.className = 'lex-group-title';
      groupTitle.textContent = group.title;
      groupDiv.appendChild(groupTitle);

      const table = document.createElement('div');
      table.className = 'lex-table';

      group.sets.forEach(setKey => {
        const set = accent.lexicalSets[setKey];
        if (!set) return;
        const row = document.createElement('div');
        row.className = 'lex-row';

        const keyEl = document.createElement('span');
        keyEl.className = 'lex-key';
        keyEl.textContent = setKey;
        row.appendChild(keyEl);

        const ipaBtn = document.createElement('button');
        ipaBtn.className = 'lex-ipa';
        ipaBtn.textContent = set.ipa;
        ipaBtn.title = 'Click to hear this sound';
        ipaBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Try to select the primary IPA symbol in the articulator
          const primaryIpa = set.ipa.replace(/[ːˑ̟̠̞̝̥̃̈̊ʰʲʷ~]/g, '').charAt(0);
          if (primaryIpa) selectSound(primaryIpa);
        });
        row.appendChild(ipaBtn);

        const exEl = document.createElement('span');
        exEl.className = 'lex-example';
        exEl.textContent = set.example;
        row.appendChild(exEl);

        const noteEl = document.createElement('span');
        noteEl.className = 'lex-notes';
        noteEl.textContent = set.notes;
        row.appendChild(noteEl);

        table.appendChild(row);
      });

      groupDiv.appendChild(table);
      lexEl.appendChild(groupDiv);
    });
  }

  // === Consonant Features ===
  const consEl = document.getElementById('accent-consonants');
  consEl.innerHTML = '';
  if (accent.consonantFeatures && accent.consonantFeatures.length > 0) {
    accent.consonantFeatures.forEach(cf => {
      const card = document.createElement('div');
      card.className = 'cons-feature-card';
      card.innerHTML = `<span class="cons-feature-label">${cf.label}</span><p class="cons-feature-desc">${cf.description}</p>`;
      consEl.appendChild(card);
    });
  } else {
    consEl.innerHTML = '<p class="accent-empty">No specific consonant features documented.</p>';
  }

  // === Mergers & Splits ===
  const mergersEl = document.getElementById('accent-mergers');
  mergersEl.innerHTML = '';
  if (accent.mergers && accent.mergers.length > 0) {
    accent.mergers.forEach(m => {
      const card = document.createElement('div');
      card.className = 'merger-card';
      card.innerHTML = `<span class="merger-label">${m.label}</span><p class="merger-desc">${m.description}</p>`;
      mergersEl.appendChild(card);
    });
  } else {
    mergersEl.innerHTML = '<p class="accent-empty">No significant mergers or splits documented.</p>';
  }

  // === Example Sentences ===
  const sentencesEl = document.getElementById('accent-sentences');
  sentencesEl.innerHTML = '';
  if (accent.exampleSentences && accent.exampleSentences.length > 0) {
    accent.exampleSentences.forEach(s => {
      const card = document.createElement('div');
      card.className = 'sentence-card';
      card.innerHTML = `
        <p class="sentence-text">${s.text}</p>
        <p class="sentence-ipa">${s.ipa}</p>
        <p class="sentence-notes">${s.notes}</p>
      `;
      sentencesEl.appendChild(card);
    });
  } else {
    sentencesEl.innerHTML = '<p class="accent-empty">No example sentences for reference accent.</p>';
  }

  // === Minimal Pairs ===
  const pairsEl = document.getElementById('accent-minimal-pairs');
  pairsEl.innerHTML = '';
  if (accent.minimalPairs && accent.minimalPairs.length > 0) {
    accent.minimalPairs.forEach(p => {
      const card = document.createElement('div');
      card.className = 'pair-card';
      card.innerHTML = `
        <div class="pair-row">
          <div class="pair-item pair-accent">
            <span class="pair-word">${p.word1}</span>
            <span class="pair-pron">${p.pron1}</span>
          </div>
          <span class="pair-vs">vs</span>
          <div class="pair-item pair-ref">
            <span class="pair-word">${p.word2}</span>
            <span class="pair-pron">${p.pron2}</span>
          </div>
        </div>
        <p class="pair-note">${p.note}</p>
      `;
      pairsEl.appendChild(card);
    });
  } else {
    pairsEl.innerHTML = '<p class="accent-empty">This is the reference accent — compare other accents against this one.</p>';
  }

  // === Prosody & Intonation ===
  const prosodyEl = document.getElementById('accent-prosody');
  prosodyEl.innerHTML = '';
  if (accent.prosody) {
    const prosodyCard = document.createElement('div');
    prosodyCard.className = 'prosody-card';

    const prosodyItems = [
      { icon: '\uD83C\uDFB5', label: 'Rhythm', text: accent.prosody.rhythm },
      { icon: '\uD83D\uDCC8', label: 'Intonation', text: accent.prosody.intonation },
      { icon: '\u23F1', label: 'Tempo', text: accent.prosody.tempo },
    ];

    prosodyItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'prosody-item';
      row.innerHTML = `<span class="prosody-icon">${item.icon}</span><div class="prosody-content"><span class="prosody-label">${item.label}</span><span class="prosody-text">${item.text}</span></div>`;
      prosodyCard.appendChild(row);
    });

    if (accent.prosody.features && accent.prosody.features.length > 0) {
      const featList = document.createElement('div');
      featList.className = 'prosody-features';
      accent.prosody.features.forEach(f => {
        const li = document.createElement('div');
        li.className = 'prosody-feature-item';
        li.textContent = f;
        featList.appendChild(li);
      });
      prosodyCard.appendChild(featList);
    }

    prosodyEl.appendChild(prosodyCard);
  }

  // === Structured Exercises ===
  const exercisesEl = document.getElementById('accent-exercises');
  exercisesEl.innerHTML = '';
  if (accent.exercises && accent.exercises.length > 0) {
    accent.exercises.forEach((ex, idx) => {
      const card = document.createElement('div');
      card.className = 'exercise-card';

      const typeColors = { vowel: '#d4a04a', consonant: '#64b478', prosody: '#6a9fd4', articulation: '#b89d65', integration: '#c47fd4' };
      const typeColor = typeColors[ex.type] || '#b89d65';

      card.innerHTML = `
        <div class="exercise-header">
          <span class="exercise-number">${idx + 1}</span>
          <div class="exercise-title-row">
            <span class="exercise-title">${ex.title}</span>
            <span class="exercise-type" style="color:${typeColor};border-color:${typeColor}44;background:${typeColor}15">${ex.type}</span>
          </div>
        </div>
        <p class="exercise-instructions">${ex.instructions}</p>
        <div class="exercise-drills">
          ${ex.drills.map(d => `<div class="exercise-drill">${d}</div>`).join('')}
        </div>
      `;
      exercisesEl.appendChild(card);
    });
  }

  // === Coaching notes ===
  document.getElementById('accent-coaching').textContent = accent.coachingNotes;

  // === Famous Speakers ===
  const speakersEl = document.getElementById('accent-speakers');
  speakersEl.innerHTML = '';
  if (accent.famousSpeakers && accent.famousSpeakers.length > 0) {
    accent.famousSpeakers.forEach(sp => {
      const card = document.createElement('div');
      card.className = 'speaker-card';
      card.innerHTML = `<span class="speaker-name">${sp.name}</span><span class="speaker-note">${sp.note}</span>`;
      speakersEl.appendChild(card);
    });
  }

  // === Regional Variations ===
  const variationsEl = document.getElementById('accent-variations');
  variationsEl.innerHTML = '';
  if (accent.regionalVariations && accent.regionalVariations.length > 0) {
    accent.regionalVariations.forEach(v => {
      const card = document.createElement('div');
      card.className = 'variation-card';
      card.innerHTML = `<span class="variation-name">${v.name}</span><p class="variation-desc">${v.description}</p>`;
      variationsEl.appendChild(card);
    });
  } else {
    variationsEl.innerHTML = '<p class="accent-empty">This is the standard reference — see other accents for regional variations.</p>';
  }

  // === Historical Context ===
  const historyEl = document.getElementById('accent-history');
  historyEl.textContent = accent.history || '';

  // === Practice words ===
  const practiceEl = document.getElementById('accent-practice');
  practiceEl.innerHTML = '';
  accent.practiceWords.forEach(w => {
    const span = document.createElement('span');
    span.className = 'accent-practice-word';
    span.textContent = w;
    practiceEl.appendChild(span);
  });

  // === Common mistakes ===
  const mistakesEl = document.getElementById('accent-mistakes');
  mistakesEl.innerHTML = '';
  accent.commonMistakes.forEach(m => {
    const div = document.createElement('div');
    div.className = 'accent-mistake';
    div.textContent = m;
    mistakesEl.appendChild(div);
  });

  // Highlight sounds on charts
  highlightAccentSounds(accentId);
}

function animateShift(fromSymbol, toSymbol) {
  selectSound(fromSymbol);
  setTimeout(() => {
    selectSound(toSymbol);
  }, 1500);
}

function highlightAccentSounds(accentId) {
  clearAccentHighlights();
  const accent = ACCENT_DATA.accents[accentId];
  if (!accent) return;

  // Highlight distinctive sounds
  if (accent.distinctiveSounds) {
    accent.distinctiveSounds.forEach(sym => {
      const btn = document.querySelector(`[data-symbol="${CSS.escape(sym)}"]`);
      if (btn) btn.classList.add('accent-highlight');
    });
  }

  // Highlight sounds from lexical sets
  if (accent.lexicalSets) {
    Object.values(accent.lexicalSets).forEach(set => {
      if (set.ipa) {
        // Extract clean IPA symbols (strip diacritics and length marks for matching)
        const cleanIpa = set.ipa.replace(/[ːˑ̟̠̞̝̥̃̈̊ʰʲʷ~]/g, '');
        for (const ch of cleanIpa) {
          const btn = document.querySelector(`[data-symbol="${CSS.escape(ch)}"]`);
          if (btn) btn.classList.add('accent-highlight');
        }
      }
    });
  }
}

function clearAccentHighlights() {
  document.querySelectorAll('.accent-highlight, .accent-shifted-from, .accent-shifted-to').forEach(el => {
    el.classList.remove('accent-highlight', 'accent-shifted-from', 'accent-shifted-to');
  });
}

// Back button
document.getElementById('accent-back')?.addEventListener('click', () => {
  document.getElementById('accent-detail').style.display = 'none';
  document.getElementById('accent-grid').style.display = '';
  activeAccentId = null;
  clearAccentHighlights();
});

// Hidden unlock: triple-click the logo to reveal Accents tab
let logoClickCount = 0;
let logoClickTimer = null;
const logoEl = document.querySelector('.header-logo-img') || document.querySelector('.logo');
if (logoEl) {
  logoEl.addEventListener('click', () => {
    logoClickCount++;
    if (logoClickTimer) clearTimeout(logoClickTimer);
    logoClickTimer = setTimeout(() => { logoClickCount = 0; }, 600);
    if (logoClickCount >= 3) {
      const accTab = document.getElementById('accents-tab');
      if (accTab) {
        accTab.style.display = '';
        accTab.classList.add('accent-tab-reveal');
      }
      logoClickCount = 0;
    }
  });
}

// ============================================
// INIT
// ============================================
buildConsonantChart();
buildVowelChart();
buildOtherChart();
buildAccentGrid();
createLabels();
animate();

// Dismiss splash screen after 2.5 seconds
setTimeout(() => {
  const splash = document.getElementById('splash-screen');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 600);
  }
}, 2500);
