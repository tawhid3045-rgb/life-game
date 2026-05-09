// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let selfData = null;
let myLat = 23.685, myLng = 90.356;
let chosenColor = '#a5c8f8';
let myDistrict = 'Bangladesh';
let map = null;
let selfMarker = null;

const playerMarkers = new Map(); // id → { marker, nameTag }
const orbMarkers    = new Map(); // id → { marker, data }
const myOrbIds      = new Set();

// ─── Bangladesh bounds ────────────────────────────────────────────────────────
const BD_BOUNDS = [[20.3, 87.9], [26.8, 93.0]];
const BD_CENTER = [23.685, 90.356];

// ─── Init Map ─────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: BD_CENTER, zoom: 7,
    maxBounds: [[19, 86], [28, 95]],
    maxBoundsViscosity: 0.85,
    zoomControl: false,
    attributionControl: false,
    minZoom: 6, maxZoom: 14
  });

  // Dark tile layer
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19
  }).addTo(map);

  // Load Bangladesh GeoJSON border
  fetch('https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson')
    .then(r => r.json())
    .then(data => {
      const bd = data.features.find(f => f.properties.ISO_A2 === 'BD');
      if (bd) {
        L.geoJSON(bd, {
          style: {
            color: '#cbb8fd', weight: 1.5, opacity: 0.55,
            fillColor: '#cbb8fd', fillOpacity: 0.03
          }
        }).addTo(map);
      }
    }).catch(() => {});

  // Click to move
  map.on('click', (e) => {
    if (!selfData) return;
    const { lat, lng } = e.latlng;
    // Stay within Bangladesh roughly
    if (lat < 20 || lat > 27 || lng < 88 || lng > 93) return;
    myLat = lat; myLng = lng;
    updateSelfMarker();
    socket.emit('player:move', { lat, lng });
  });
}

// ─── Avatar marker ────────────────────────────────────────────────────────────
function makeAvatarIcon(color, isSelf, name) {
  const size  = isSelf ? 38 : 30;
  const ring  = isSelf ? 3  : 2;
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none">
      <div style="
        width:${size}px;height:${size}px;border-radius:50%;
        background:${color};
        border:${ring}px solid rgba(255,255,255,${isSelf?0.85:0.6});
        box-shadow:0 0 ${isSelf?22:14}px ${color},0 2px 8px rgba(0,0,0,0.5);
        ${isSelf?'animation:self-pulse 2.5s ease-in-out infinite;':''}
      "></div>
      ${!isSelf ? `<div style="
        background:rgba(10,8,18,0.78);border:1px solid rgba(255,255,255,0.1);
        border-radius:100px;padding:2px 8px;margin-top:3px;
        font-family:'DM Sans',sans-serif;font-size:8px;color:rgba(255,245,255,0.75);
        white-space:nowrap;backdrop-filter:blur(8px);
      ">${name}</div>` : ''}
    </div>`;
  return L.divIcon({
    html, className: '', iconSize: [size, isSelf ? size+22 : size+22],
    iconAnchor: [size/2, size/2]
  });
}

function makeOrbIcon(isMine) {
  const color = isMine ? '#f9b8d0' : '#cbb8fd';
  const html = `<div style="
    width:14px;height:14px;border-radius:50%;
    background:radial-gradient(circle at 35% 35%,rgba(255,255,255,0.9),${color});
    box-shadow:0 0 12px ${color},0 0 24px ${color}66;
    animation:orb-glow 2.5s ease-in-out infinite alternate;
  "></div>`;
  return L.divIcon({ html, className: '', iconSize: [14,14], iconAnchor: [7,7] });
}

// ─── Self marker ──────────────────────────────────────────────────────────────
function updateSelfMarker() {
  if (!map || !selfData) return;
  if (selfMarker) map.removeLayer(selfMarker);
  selfMarker = L.marker([myLat, myLng], {
    icon: makeAvatarIcon(selfData.color, true, selfData.name),
    zIndexOffset: 1000
  }).addTo(map);
}

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('init', (data) => {
  selfData = data.self;
  myLat = selfData.lat; myLng = selfData.lng;

  document.getElementById('hud-name').textContent = selfData.name;
  document.getElementById('hud-district').textContent = myDistrict;
  updatePresence(data.players.length);
  applyMood(data.globalMood);
  updateSelfMarker();
  map.setView([myLat, myLng], 9);

  data.players.forEach(p => {
    if (p.id !== socket.id) addPlayerMarker(p);
  });
  data.orbs.forEach(o => addOrbMarker(o, false));
});

socket.on('player:join', (p) => {
  addPlayerMarker(p);
  updatePresence();
});

socket.on('player:leave', ({ id }) => {
  removePlayerMarker(id);
  updatePresence();
});

socket.on('player:moved', ({ id, lat, lng }) => {
  const pm = playerMarkers.get(id);
  if (pm) pm.marker.setLatLng([lat, lng]);
});

socket.on('orb:placed', (orb) => {
  if (orb.mine) myOrbIds.add(orb.id);
  addOrbMarker(orb, orb.mine);
  playOrbChime();
});

socket.on('orb:deleted', ({ id }) => {
  const om = orbMarkers.get(id);
  if (om) { map.removeLayer(om.marker); orbMarkers.delete(id); }
  myOrbIds.delete(id);
  hideOrbPopup();
});

socket.on('orb:content', ({ id, text, district }) => {
  showOrbPopup(id, text, district);
});

socket.on('world:mood', (gm) => applyMood(gm));

// ─── Add/Remove markers ───────────────────────────────────────────────────────
function addPlayerMarker(p) {
  if (!map) return;
  const marker = L.marker([p.lat, p.lng], {
    icon: makeAvatarIcon(p.color, false, p.name)
  }).addTo(map);
  playerMarkers.set(p.id, { marker });
}

function removePlayerMarker(id) {
  const pm = playerMarkers.get(id);
  if (pm) { map.removeLayer(pm.marker); playerMarkers.delete(id); }
}

function addOrbMarker(orb, isMine) {
  if (!map) return;
  const marker = L.marker([orb.lat, orb.lng], {
    icon: makeOrbIcon(isMine)
  }).addTo(map);

  marker.on('click', () => {
    const stored = orbMarkers.get(orb.id);
    if (stored && stored.text) {
      showOrbPopup(orb.id, stored.text, orb.district);
    } else {
      socket.emit('orb:read', { id: orb.id });
    }
    // Show delete hint if mine
    if (myOrbIds.has(orb.id)) {
      document.getElementById('orb-ago').textContent += ' · press X to delete';
      currentOrbId = orb.id;
    }
  });

  orbMarkers.set(orb.id, { marker, data: orb, text: orb.text, isMine });
}

// ─── Orb popup ────────────────────────────────────────────────────────────────
let currentOrbId = null;

function showOrbPopup(id, text, district) {
  currentOrbId = id;
  const orb = orbMarkers.get(id);
  if (orb) orb.text = text;

  document.getElementById('orb-text').textContent = `"${text}"`;
  document.getElementById('orb-district').textContent = district ? `📍 ${district}` : '';
  const createdAt = orb?.data?.createdAt;
  document.getElementById('orb-ago').textContent = createdAt ? timeAgo(createdAt) : '';

  const popup = document.getElementById('orb-popup');
  popup.classList.remove('hidden');
  popup.style.display = 'block'; popup.style.opacity = '1';

  clearTimeout(popup._timer);
  popup._timer = setTimeout(hideOrbPopup, 5000);
}

function hideOrbPopup() {
  const popup = document.getElementById('orb-popup');
  popup.classList.add('hidden'); currentOrbId = null;
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000)    return 'just now';
  if (d < 3600000)  return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

// ─── Mood ─────────────────────────────────────────────────────────────────────
const MOOD_NAMES = {5:'ecstatic',4:'happy',3:'neutral',2:'melancholy',1:'lost'};
function applyMood(gm) {
  const rounded = Math.round(gm.mood);
  document.getElementById('mood-value').textContent = MOOD_NAMES[rounded] || 'neutral';
}

document.querySelectorAll('.mood-opt').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.mood-opt').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    socket.emit('player:mood', el.dataset.mood);
  });
});

// ─── Presence ─────────────────────────────────────────────────────────────────
function updatePresence(count) {
  const n = count !== undefined ? count : playerMarkers.size + 1;
  document.getElementById('presence-count').textContent = n;
  document.getElementById('presence-label').textContent = n === 1 ? 'soul' : 'souls';
}

// ─── Memory input ─────────────────────────────────────────────────────────────
let memoryOpen = false;

function openMemory() {
  if (memoryOpen) return;
  memoryOpen = true;
  document.getElementById('memory-overlay').classList.remove('hidden');
  document.getElementById('memory-input').value = '';
  document.getElementById('memory-chars').textContent = '100';
  setTimeout(() => document.getElementById('memory-input').focus(), 50);
}

function closeMemory() {
  if (!memoryOpen) return;
  memoryOpen = false;
  document.getElementById('memory-overlay').classList.add('hidden');
}

function submitMemory() {
  const text = document.getElementById('memory-input').value.trim();
  if (!text) { closeMemory(); return; }
  socket.emit('orb:create', { text, lat: myLat, lng: myLng, district: myDistrict });
  playMemorySound();
  closeMemory();
}

document.getElementById('memory-input').addEventListener('input', e => {
  document.getElementById('memory-chars').textContent = 100 - e.target.value.length;
});
document.getElementById('memory-submit').addEventListener('click', submitMemory);
document.getElementById('memory-fab').addEventListener('click', openMemory);

// ─── Keyboard ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (memoryOpen) {
    if (e.key === 'Escape') closeMemory();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitMemory();
    return;
  }
  if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openMemory(); }
  if ((e.key === 'x' || e.key === 'X') && currentOrbId && myOrbIds.has(currentOrbId)) {
    socket.emit('orb:delete', { id: currentOrbId });
  }
  if (e.key === 'Escape') hideOrbPopup();
});

// ─── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null, masterGain = null, isMuted = false;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.15;
  masterGain.connect(audioCtx.destination);
  startDrone();
}

function startDrone() {
  if (!audioCtx) return;
  const osc1 = audioCtx.createOscillator();
  const g1 = audioCtx.createGain();
  osc1.type = 'sine'; osc1.frequency.value = 55; g1.gain.value = 0.35;
  osc1.connect(g1); g1.connect(masterGain); osc1.start();

  const osc2 = audioCtx.createOscillator();
  const g2 = audioCtx.createGain();
  osc2.type = 'sine'; osc2.frequency.value = 110.5; g2.gain.value = 0.12;
  osc2.connect(g2); g2.connect(masterGain); osc2.start();

  const lfo = audioCtx.createOscillator();
  const lg = audioCtx.createGain();
  lfo.frequency.value = 0.08; lg.gain.value = 3;
  lfo.connect(lg); lg.connect(osc2.frequency); lfo.start();
}

function playOrbChime() {
  if (!audioCtx || isMuted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = 'sine'; osc.frequency.setValueAtTime(660, t);
  osc.frequency.exponentialRampToValueAtTime(440, t+0.6);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.2, t+0.05);
  env.gain.exponentialRampToValueAtTime(0.001, t+0.8);
  osc.connect(env); env.connect(masterGain);
  osc.start(t); osc.stop(t+0.8);
}

function playMemorySound() {
  if (!audioCtx || isMuted) return;
  const t = audioCtx.currentTime;
  [440, 554, 659].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t + i*0.12);
    env.gain.linearRampToValueAtTime(0.18, t + i*0.12 + 0.05);
    env.gain.exponentialRampToValueAtTime(0.001, t + i*0.12 + 1.2);
    osc.connect(env); env.connect(masterGain);
    osc.start(t + i*0.12); osc.stop(t + i*0.12 + 1.3);
  });
}

document.getElementById('mute-btn').addEventListener('click', () => {
  initAudio(); isMuted = !isMuted;
  masterGain.gain.value = isMuted ? 0 : 0.15;
  document.getElementById('mute-btn').classList.toggle('muted', isMuted);
});

// ─── Customize screen ─────────────────────────────────────────────────────────
let chosenDistrict = '';
let gpsLat = null, gpsLng = null;

// Color picker
document.querySelectorAll('.color-opt').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.color-opt').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    chosenColor = el.dataset.color;
    drawPreview(chosenColor);
  });
});

function drawPreview(color) {
  const pc = document.getElementById('preview-canvas');
  const px = pc.getContext('2d');
  px.clearRect(0, 0, 60, 60);
  const grad = px.createRadialGradient(22, 22, 0, 30, 30, 30);
  grad.addColorStop(0, '#fff'); grad.addColorStop(1, color);
  px.beginPath(); px.arc(30, 30, 20, 0, Math.PI*2);
  px.fillStyle = grad; px.fill();
  px.beginPath(); px.arc(30, 30, 24, 0, Math.PI*2);
  px.strokeStyle = color + '88'; px.lineWidth = 3; px.stroke();
}
drawPreview(chosenColor);

// GPS detection
function detectLocation() {
  const locText = document.getElementById('loc-text');
  const locStatus = document.getElementById('location-status');
  const districtPicker = document.getElementById('district-picker');

  if (!navigator.geolocation) {
    locText.textContent = 'GPS not available — pick your district';
    locStatus.className = 'error';
    districtPicker.classList.remove('hidden');
    return;
  }

  locText.textContent = 'detecting your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gpsLat = pos.coords.latitude;
      gpsLng = pos.coords.longitude;
      // Reverse geocode district name
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${gpsLat}&lon=${gpsLng}&format=json`)
        .then(r => r.json())
        .then(d => {
          const dist = d.address?.county || d.address?.state_district || d.address?.city || 'Bangladesh';
          myDistrict = dist;
          locText.textContent = `📍 ${dist}`;
          locStatus.className = 'success';
        })
        .catch(() => {
          myDistrict = 'Bangladesh';
          locText.textContent = '📍 location found';
          locStatus.className = 'success';
        });
    },
    () => {
      locText.textContent = 'GPS denied — pick your district below';
      locStatus.className = 'error';
      districtPicker.classList.remove('hidden');
    },
    { timeout: 8000 }
  );
}

// District select fallback
const DISTRICT_COORDS = {
  'Dhaka': [23.8103, 90.4125], 'Chittagong': [22.3569, 91.7832],
  'Sylhet': [24.8949, 91.8687], 'Rajshahi': [24.3745, 88.6042],
  'Khulna': [22.8456, 89.5403], 'Barisal': [22.7010, 90.3535],
  'Rangpur': [25.7439, 89.2752], 'Mymensingh': [24.7471, 90.4203],
  'Comilla': [23.4607, 91.1809], 'Narayanganj': [23.6238, 90.4996],
  'Gazipur': [23.9999, 90.4203], 'Tangail': [24.2513, 89.9167],
  'Bogra': [24.8481, 89.3722], 'Jessore': [23.1667, 89.2167],
  "Cox's Bazar": [21.4272, 92.0058], 'Noakhali': [22.8696, 91.0978],
  'Dinajpur': [25.6279, 88.6338], 'Pabna': [24.0064, 89.2372],
  'Faridpur': [23.6070, 89.8429], 'Brahmanbaria': [23.9608, 91.1115]
};

document.getElementById('district-select').addEventListener('change', (e) => {
  const d = e.target.value;
  if (!d) return;
  myDistrict = d;
  const coords = DISTRICT_COORDS[d];
  if (coords) { gpsLat = coords[0]; gpsLng = coords[1]; }
});

function enterWorld() {
  const nameInput = document.getElementById('custom-name').value.trim();
  const customize = document.getElementById('customize-screen');

  if (gpsLat) { myLat = gpsLat; myLng = gpsLng; }

  customize.classList.add('fade-out');
  setTimeout(() => { customize.style.display = 'none'; }, 500);

  initAudio();
  socket.emit('player:join', {
    name: nameInput, color: chosenColor,
    lat: myLat, lng: myLng, district: myDistrict
  });
  document.getElementById('hud-district').textContent = myDistrict;
}

document.getElementById('customize-enter').addEventListener('click', enterWorld);
document.getElementById('custom-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') enterWorld();
});

// ─── Splash ───────────────────────────────────────────────────────────────────
const splash = document.getElementById('splash');

function dismissSplash() {
  splash.classList.add('fade-out');
  setTimeout(() => {
    splash.style.display = 'none';
    const customize = document.getElementById('customize-screen');
    customize.classList.remove('hidden');
    detectLocation();
    setTimeout(() => document.getElementById('custom-name').focus(), 200);
  }, 900);
}

splash.addEventListener('click', dismissSplash);
splash.addEventListener('touchend', dismissSplash);

// ─── Init ─────────────────────────────────────────────────────────────────────
initMap();
