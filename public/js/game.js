// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let selfData = null;
let myLat = 23.685, myLng = 90.356;
let chosenColor = '#a5c8f8';
let myDistrict = 'Bangladesh';
let map = null;
let selfMarker = null;
let moveInterval = null;

const playerMarkers = new Map();
const orbMarkers    = new Map();
const myOrbIds      = new Set();

// ─── Init Map ─────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [23.685, 90.356],
    zoom: 7,
    zoomControl: true,
    attributionControl: false,
    minZoom: 5,
    maxZoom: 20
  });

  // Stylized game-like dark map (not realistic)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 20,
    tileSize: 256,
    className: 'game-tiles'
  }).addTo(map);

  // Bangladesh GeoJSON border overlay
  fetch('https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson')
    .then(r => r.json())
    .then(data => {
      const bd = data.features.find(f => f.properties.ISO_A2 === 'BD');
      if (bd) {
        L.geoJSON(bd, {
          style: {
            color: '#cbb8fd', weight: 2, opacity: 0.7,
            fillColor: 'transparent', fillOpacity: 0
          }
        }).addTo(map);
      }
    }).catch(() => {});

  // Click to move
  map.on('click', (e) => {
    if (!selfData) return;
    const { lat, lng } = e.latlng;
    myLat = lat; myLng = lng;
    moveSelfMarkerTo(lat, lng);
    socket.emit('player:move', { lat, lng });
  });
}

// ─── Avatar icon ──────────────────────────────────────────────────────────────
function makeAvatarIcon(color, isSelf, name) {
  const size = isSelf ? 36 : 28;
  const pulse = isSelf ? `animation:self-pulse 2.5s ease-in-out infinite;` : '';
  const nameTag = !isSelf ? `
    <div style="
      background:rgba(10,8,18,0.82);border:1px solid rgba(255,255,255,0.12);
      border-radius:100px;padding:2px 8px;margin-top:3px;
      font-family:'DM Sans',sans-serif;font-size:8px;color:rgba(255,245,255,0.8);
      white-space:nowrap;backdrop-filter:blur(8px);text-align:center;
    ">${name}</div>` : '';

  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
      <div style="
        width:${size}px;height:${size}px;border-radius:50%;
        background:radial-gradient(circle at 35% 35%, rgba(255,255,255,0.9), ${color});
        border:${isSelf?3:2}px solid rgba(255,255,255,${isSelf?0.9:0.65});
        box-shadow:0 0 ${isSelf?24:14}px ${color}, 0 0 ${isSelf?48:28}px ${color}66, 0 3px 10px rgba(0,0,0,0.6);
        ${pulse}
      "></div>
      ${nameTag}
    </div>`;

  return L.divIcon({
    html, className: '',
    iconSize: [size, size + (isSelf ? 0 : 22)],
    iconAnchor: [size/2, size/2]
  });
}

function makeOrbIcon(isMine) {
  const color = isMine ? '#f9b8d0' : '#cbb8fd';
  const glow  = isMine ? '#f9b8d088' : '#cbb8fd88';
  const html = `
    <div style="
      width:16px;height:16px;border-radius:50%;
      background:radial-gradient(circle at 35% 35%, rgba(255,255,255,0.95), ${color});
      box-shadow:0 0 14px ${color}, 0 0 28px ${glow};
      animation:orb-glow 2.5s ease-in-out infinite alternate;
    "></div>`;
  return L.divIcon({ html, className: '', iconSize: [16,16], iconAnchor: [8,8] });
}

// ─── Self marker ──────────────────────────────────────────────────────────────
function moveSelfMarkerTo(lat, lng) {
  if (!map || !selfData) return;
  if (!selfMarker) {
    selfMarker = L.marker([lat, lng], {
      icon: makeAvatarIcon(selfData.color, true, selfData.name),
      zIndexOffset: 1000,
      draggable: false
    }).addTo(map);
  } else {
    selfMarker.setLatLng([lat, lng]);
  }
}

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('init', (data) => {
  selfData = data.self;
  myLat = selfData.lat; myLng = selfData.lng;

  document.getElementById('hud-name').textContent = selfData.name;
  document.getElementById('hud-district').textContent = myDistrict;
  updatePresence(data.players.length);
  applyMood(data.globalMood);

  moveSelfMarkerTo(myLat, myLng);
  map.setView([myLat, myLng], 13);
  startMoveLoop();

  data.players.forEach(p => { if (p.id !== socket.id) addPlayerMarker(p); });
  data.orbs.forEach(o => addOrbMarker(o, false));
});

socket.on('player:join', (p) => { addPlayerMarker(p); updatePresence(); });
socket.on('player:leave', ({ id }) => { removePlayerMarker(id); updatePresence(); });
socket.on('player:moved', ({ id, lat, lng }) => {
  const pm = playerMarkers.get(id);
  if (pm) pm.setLatLng([lat, lng]);
});

socket.on('orb:placed', (orb) => {
  if (orb.mine) myOrbIds.add(orb.id);
  addOrbMarker(orb, !!orb.mine);
  playOrbChime();
});

socket.on('orb:deleted', ({ id }) => {
  const om = orbMarkers.get(id);
  if (om) { map.removeLayer(om.marker); orbMarkers.delete(id); }
  myOrbIds.delete(id);
  if (currentOrbId === id) hideOrbPopup();
});

socket.on('orb:content', ({ id, text, district }) => {
  const om = orbMarkers.get(id);
  if (om) om.text = text;
  showOrbPopup(id, text, district, om?.data?.createdAt);
});

socket.on('world:mood', (gm) => applyMood(gm));

// ─── Markers ──────────────────────────────────────────────────────────────────
function addPlayerMarker(p) {
  if (!map) return;
  const marker = L.marker([p.lat, p.lng], {
    icon: makeAvatarIcon(p.color, false, p.name)
  }).addTo(map);
  playerMarkers.set(p.id, marker);
}

function removePlayerMarker(id) {
  const m = playerMarkers.get(id);
  if (m) { map.removeLayer(m); playerMarkers.delete(id); }
}

function addOrbMarker(orb, isMine) {
  if (!map) return;
  const marker = L.marker([orb.lat, orb.lng], {
    icon: makeOrbIcon(isMine)
  }).addTo(map);

  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    currentOrbId = orb.id;
    const stored = orbMarkers.get(orb.id);
    if (stored?.text) {
      showOrbPopup(orb.id, stored.text, orb.district, orb.createdAt);
    } else {
      socket.emit('orb:read', { id: orb.id });
    }
  });

  orbMarkers.set(orb.id, { marker, data: orb, text: null, isMine });
}

// ─── Orb popup ────────────────────────────────────────────────────────────────
let currentOrbId = null;

function showOrbPopup(id, text, district, createdAt) {
  currentOrbId = id;
  document.getElementById('orb-text').textContent = `"${text}"`;
  document.getElementById('orb-district').textContent = district ? `📍 ${district}` : '';
  document.getElementById('orb-ago').textContent = createdAt ? timeAgo(createdAt) : '';

  const isMine = myOrbIds.has(id);
  if (isMine) {
    document.getElementById('orb-ago').textContent += ' · press X to delete';
  }

  const popup = document.getElementById('orb-popup');
  popup.style.display = 'block';
  popup.classList.remove('hidden');
  popup.style.opacity = '1';
  clearTimeout(popup._t);
  popup._t = setTimeout(hideOrbPopup, 6000);
}

function hideOrbPopup() {
  document.getElementById('orb-popup').classList.add('hidden');
  currentOrbId = null;
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
  document.getElementById('mood-value').textContent = MOOD_NAMES[Math.round(gm.mood)] || 'neutral';
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

// ─── Keyboard movement ───────────────────────────────────────────────────────
const keys = {};
let moveLoop = null;
const MOVE_SPEED = 0.0003; // degrees per tick

window.addEventListener('keydown', e => {
  if (memoryOpen) {
    if (e.key === 'Escape') closeMemory();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitMemory();
    return;
  }
  keys[e.key] = true;
  if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openMemory(); }
  if ((e.key === 'x' || e.key === 'X') && currentOrbId && myOrbIds.has(currentOrbId)) {
    socket.emit('orb:delete', { id: currentOrbId });
  }
  if (e.key === 'Escape') hideOrbPopup();
});

window.addEventListener('keyup', e => { keys[e.key] = false; });

function startMoveLoop() {
  if (moveLoop) return;
  let lastEmit = 0;
  moveLoop = setInterval(() => {
    if (!selfData) return;
    let moved = false;
    const speed = MOVE_SPEED * (map.getZoom() < 10 ? 3 : map.getZoom() < 14 ? 1.5 : 0.8);

    if (keys['ArrowUp']    || keys['w'] || keys['W']) { myLat += speed; moved = true; }
    if (keys['ArrowDown']  || keys['s'] || keys['S']) { myLat -= speed; moved = true; }
    if (keys['ArrowLeft']  || keys['a'] || keys['A']) { myLng -= speed; moved = true; }
    if (keys['ArrowRight'] || keys['d'] || keys['D']) { myLng += speed; moved = true; }

    if (moved) {
      moveSelfMarkerTo(myLat, myLng);
      map.panTo([myLat, myLng], { animate: false });
      const now = Date.now();
      if (now - lastEmit > 50) {
        socket.emit('player:move', { lat: myLat, lng: myLng });
        lastEmit = now;
      }
    }
  }, 16); // ~60fps
}

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
  const o1 = audioCtx.createOscillator(), g1 = audioCtx.createGain();
  o1.type = 'sine'; o1.frequency.value = 55; g1.gain.value = 0.3;
  o1.connect(g1); g1.connect(masterGain); o1.start();
  const o2 = audioCtx.createOscillator(), g2 = audioCtx.createGain();
  o2.type = 'sine'; o2.frequency.value = 110.5; g2.gain.value = 0.1;
  o2.connect(g2); g2.connect(masterGain); o2.start();
  const lfo = audioCtx.createOscillator(), lg = audioCtx.createGain();
  lfo.frequency.value = 0.08; lg.gain.value = 3;
  lfo.connect(lg); lg.connect(o2.frequency); lfo.start();
}

function playOrbChime() {
  if (!audioCtx || isMuted) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), e = audioCtx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(660, t);
  o.frequency.exponentialRampToValueAtTime(440, t+0.6);
  e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.2, t+0.05);
  e.gain.exponentialRampToValueAtTime(0.001, t+0.8);
  o.connect(e); e.connect(masterGain); o.start(t); o.stop(t+0.8);
}

function playMemorySound() {
  if (!audioCtx || isMuted) return;
  const t = audioCtx.currentTime;
  [440, 554, 659].forEach((freq, i) => {
    const o = audioCtx.createOscillator(), e = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    e.gain.setValueAtTime(0, t+i*0.12);
    e.gain.linearRampToValueAtTime(0.18, t+i*0.12+0.05);
    e.gain.exponentialRampToValueAtTime(0.001, t+i*0.12+1.2);
    o.connect(e); e.connect(masterGain); o.start(t+i*0.12); o.stop(t+i*0.12+1.3);
  });
}

document.getElementById('mute-btn').addEventListener('click', () => {
  initAudio(); isMuted = !isMuted;
  masterGain.gain.value = isMuted ? 0 : 0.15;
  document.getElementById('mute-btn').classList.toggle('muted', isMuted);
});

// ─── Customize ────────────────────────────────────────────────────────────────
let gpsLat = null, gpsLng = null;

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
  px.clearRect(0,0,60,60);
  const g = px.createRadialGradient(22,22,0,30,30,30);
  g.addColorStop(0,'#fff'); g.addColorStop(1,color);
  px.beginPath(); px.arc(30,30,20,0,Math.PI*2);
  px.fillStyle = g; px.fill();
  px.beginPath(); px.arc(30,30,24,0,Math.PI*2);
  px.strokeStyle = color+'88'; px.lineWidth = 3; px.stroke();
}
drawPreview(chosenColor);

function detectLocation() {
  const locText   = document.getElementById('loc-text');
  const locStatus = document.getElementById('location-status');
  const distPick  = document.getElementById('district-picker');

  if (!navigator.geolocation) {
    locText.textContent = 'GPS not available — pick district below';
    locStatus.className = 'error';
    distPick.classList.remove('hidden');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      gpsLat = pos.coords.latitude; gpsLng = pos.coords.longitude;
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${gpsLat}&lon=${gpsLng}&format=json`)
        .then(r => r.json())
        .then(d => {
          myDistrict = d.address?.county || d.address?.state_district || d.address?.city || 'Bangladesh';
          locText.textContent = `📍 ${myDistrict}`;
          locStatus.className = 'success';
        }).catch(() => {
          myDistrict = 'Bangladesh';
          locText.textContent = '📍 location found';
          locStatus.className = 'success';
        });
    },
    () => {
      locText.textContent = 'GPS denied — pick district below';
      locStatus.className = 'error';
      distPick.classList.remove('hidden');
    },
    { timeout: 8000 }
  );
}

const DISTRICT_COORDS = {
  'Dhaka':[23.8103,90.4125],'Chittagong':[22.3569,91.7832],'Sylhet':[24.8949,91.8687],
  'Rajshahi':[24.3745,88.6042],'Khulna':[22.8456,89.5403],'Barisal':[22.7010,90.3535],
  'Rangpur':[25.7439,89.2752],'Mymensingh':[24.7471,90.4203],'Comilla':[23.4607,91.1809],
  'Narayanganj':[23.6238,90.4996],'Gazipur':[23.9999,90.4203],'Tangail':[24.2513,89.9167],
  'Bogra':[24.8481,89.3722],'Jessore':[23.1667,89.2167],"Cox's Bazar":[21.4272,92.0058],
  'Noakhali':[22.8696,91.0978],'Dinajpur':[25.6279,88.6338],'Pabna':[24.0064,89.2372],
  'Faridpur':[23.6070,89.4290],'Brahmanbaria':[23.9608,91.1115]
};

document.getElementById('district-select').addEventListener('change', e => {
  const d = e.target.value; if (!d) return;
  myDistrict = d;
  const c = DISTRICT_COORDS[d];
  if (c) { gpsLat = c[0]; gpsLng = c[1]; }
});

function enterWorld() {
  const name = document.getElementById('custom-name').value.trim();
  if (gpsLat) { myLat = gpsLat; myLng = gpsLng; }

  const cs = document.getElementById('customize-screen');
  cs.classList.add('fade-out');
  setTimeout(() => { cs.style.display = 'none'; }, 500);

  initAudio();
  socket.emit('player:join', { name, color: chosenColor, lat: myLat, lng: myLng, district: myDistrict });
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
    document.getElementById('customize-screen').classList.remove('hidden');
    detectLocation();
    setTimeout(() => document.getElementById('custom-name').focus(), 200);
  }, 900);
}
splash.addEventListener('click', dismissSplash);
splash.addEventListener('touchend', dismissSplash);

// ─── Keyframe injection ───────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
  @keyframes self-pulse {
    0%,100% { box-shadow: 0 0 22px currentColor, 0 0 44px currentColor44; }
    50%      { box-shadow: 0 0 36px currentColor, 0 0 0 10px transparent; }
  }
  @keyframes orb-glow {
    from { transform: scale(1); opacity: 0.85; }
    to   { transform: scale(1.25); opacity: 1; }
  }
`;
document.head.appendChild(style);

// ─── Boot ─────────────────────────────────────────────────────────────────────
initMap();
