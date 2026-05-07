// ─── Connection ───────────────────────────────────────────────────────────────
const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let self = null;
const players = new Map();   // id → { x, y, color, name, targetX, targetY }
const orbs = new Map();      // id → { x, y, createdAt, text? }
const myOrbIds = new Set();  // orb ids that belong to this player

let camera = { x: 0, y: 0 };
let worldHue = 240;

const keys = {};
const SPEED = 4;
const SMOOTH = 0.14;
let lastMoveTime = 0;
const MOVE_THROTTLE = 40; // ms

// ─── Canvas Setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', resize);

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('init', (data) => {
  self = data.self;

  // Populate players
  data.players.forEach(p => {
    if (p.id !== socket.id) {
      players.set(p.id, { ...p, targetX: p.x, targetY: p.y, renderX: p.x, renderY: p.y });
    }
  });

  // Populate orbs
  data.orbs.forEach(o => orbs.set(o.id, { ...o }));

  // Camera starts at self
  camera.x = self.x - canvas.width / 2;
  camera.y = self.y - canvas.height / 2;

  // HUD
  document.getElementById('hud-name').textContent = self.name;
  updatePresence();
  applyMood(data.globalMood);
});

socket.on('player:join', (p) => {
  players.set(p.id, { ...p, targetX: p.x, targetY: p.y, renderX: p.x, renderY: p.y });
  updatePresence();
});

socket.on('player:leave', ({ id }) => {
  players.delete(id);
  updatePresence();
});

socket.on('player:moved', ({ id, x, y }) => {
  const p = players.get(id);
  if (p) { p.targetX = x; p.targetY = y; }
});

socket.on('orb:placed', (orb) => {
  orbs.set(orb.id, { ...orb });
  if (orb.mine) myOrbIds.add(orb.id); // server flags it for the author
  spawnOrbPulse(orb.x, orb.y);
});

socket.on('orb:deleted', ({ id }) => {
  orbs.delete(id);
  myOrbIds.delete(id);
  if (currentPopupOrb === id) hideOrbPopup();
  nearOrb = null;
});

socket.on('orb:content', ({ id, text }) => {
  const orb = orbs.get(id);
  if (orb) { orb.text = text; }
  showOrbPopup(id, text);
});

socket.on('world:mood', (gm) => {
  applyMood(gm);
});

// ─── World Mood ────────────────────────────────────────────────────────────────
const MOOD_NAMES = { 5: 'ecstatic', 4: 'happy', 3: 'neutral', 2: 'melancholy', 1: 'lost' };

function applyMood(gm) {
  worldHue = gm.hue;
  const rounded = Math.round(gm.mood);
  document.getElementById('mood-value').textContent = MOOD_NAMES[rounded] || 'neutral';
}

// ─── Player Movement ──────────────────────────────────────────────────────────
function updateMovement(dt) {
  if (!self) return;
  let dx = 0, dy = 0;
  if (keys['ArrowUp']    || keys['w'] || keys['W']) dy -= 1;
  if (keys['ArrowDown']  || keys['s'] || keys['S']) dy += 1;
  if (keys['ArrowLeft']  || keys['a'] || keys['A']) dx -= 1;
  if (keys['ArrowRight'] || keys['d'] || keys['D']) dx += 1;

  if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }

  self.x += dx * SPEED;
  self.y += dy * SPEED;

  const now = Date.now();
  if ((dx !== 0 || dy !== 0) && now - lastMoveTime > MOVE_THROTTLE) {
    socket.emit('player:move', { x: self.x, y: self.y });
    lastMoveTime = now;
  }
}

// ─── Camera Lerp ──────────────────────────────────────────────────────────────
function updateCamera() {
  if (!self) return;
  const targetX = self.x - canvas.width / 2;
  const targetY = self.y - canvas.height / 2;
  camera.x += (targetX - camera.x) * SMOOTH;
  camera.y += (targetY - camera.y) * SMOOTH;
}

// ─── Grid Background ──────────────────────────────────────────────────────────
function drawGrid() {
  const alpha = 0.06;
  ctx.strokeStyle = `hsla(${worldHue}, 60%, 60%, ${alpha})`;
  ctx.lineWidth = 1;

  const gridSize = 80;
  const offX = ((-camera.x) % gridSize + gridSize) % gridSize;
  const offY = ((-camera.y) % gridSize + gridSize) % gridSize;

  ctx.beginPath();
  for (let x = offX; x < canvas.width; x += gridSize) {
    ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
  }
  for (let y = offY; y < canvas.height; y += gridSize) {
    ctx.moveTo(0, y); ctx.lineTo(canvas.width, y);
  }
  ctx.stroke();
}

// ─── Background ───────────────────────────────────────────────────────────────
function drawBackground() {
  const grad = ctx.createRadialGradient(
    canvas.width/2, canvas.height/2, 0,
    canvas.width/2, canvas.height/2, Math.max(canvas.width, canvas.height)
  );
  const h = worldHue;
  grad.addColorStop(0,   `hsla(${h}, 30%, 8%, 1)`);
  grad.addColorStop(0.5, `hsla(${h}, 20%, 5%, 1)`);
  grad.addColorStop(1,   `hsla(${h}, 10%, 3%, 1)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ─── Orb Drawing ──────────────────────────────────────────────────────────────
let time = 0;
const orbPulses = []; // { x, y, r, alpha }

function drawOrbs() {
  orbs.forEach((orb, id) => {
    const sx = orb.x - camera.x;
    const sy = orb.y - camera.y;
    if (sx < -60 || sx > canvas.width + 60 || sy < -60 || sy > canvas.height + 60) return;

    const isMine = myOrbIds.has(id);
    const pulse = Math.sin(time * 0.04 + id * 0.7) * 0.5 + 0.5;
    const r = 7 + pulse * 3;
    const orbHue = isMine ? (worldHue + 120) : (worldHue + 60); // own orbs = different hue

    // Glow layers
    for (let i = 3; i >= 0; i--) {
      const glowR = r + i * 8;
      const glowAlpha = 0.06 * (4 - i) * pulse;
      ctx.beginPath();
      ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
      g.addColorStop(0, `hsla(${orbHue}, 80%, 80%, ${glowAlpha})`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fill();
    }

    // Core
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    const coreGrad = ctx.createRadialGradient(sx - r*0.3, sy - r*0.3, 0, sx, sy, r);
    coreGrad.addColorStop(0, `hsla(${orbHue+20}, 100%, 95%, 0.95)`);
    coreGrad.addColorStop(1, `hsla(${orbHue}, 90%, 70%, 0.7)`);
    ctx.fillStyle = coreGrad;
    ctx.fill();

    // "mine" indicator — small X hint when nearby
    if (isMine && nearOrb === id) {
      ctx.fillStyle = `hsla(${orbHue}, 80%, 80%, 0.6)`;
      ctx.font = `8px 'Space Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('X to delete', sx, sy + r + 14);
    }
  });
}

function spawnOrbPulse(wx, wy) {
  orbPulses.push({ wx, wy, r: 0, alpha: 0.8, life: 1 });
}

function drawOrbPulses() {
  for (let i = orbPulses.length - 1; i >= 0; i--) {
    const p = orbPulses[i];
    p.r += 3; p.alpha -= 0.02; p.life -= 0.02;
    if (p.life <= 0) { orbPulses.splice(i, 1); continue; }

    const sx = p.wx - camera.x;
    const sy = p.wy - camera.y;
    ctx.beginPath();
    ctx.arc(sx, sy, p.r, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${worldHue+60}, 80%, 80%, ${p.alpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ─── Player Drawing ───────────────────────────────────────────────────────────
function hexToHsl(hex) {
  let r = parseInt(hex.slice(1,3), 16) / 255;
  let g = parseInt(hex.slice(3,5), 16) / 255;
  let b = parseInt(hex.slice(5,7), 16) / 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h*360), s: Math.round(s*100), l: Math.round(l*100) };
}

function drawPlayer(p, isSelf) {
  const sx = p.x - camera.x;
  const sy = p.y - camera.y;

  if (sx < -80 || sx > canvas.width + 80 || sy < -80 || sy > canvas.height + 80) return;

  const { h, s, l } = hexToHsl(p.color || '#c084fc');
  const r = isSelf ? 14 : 10;
  const pulse = isSelf ? Math.sin(time * 0.05) * 0.3 + 0.7 : 1;

  // Outer glow
  for (let i = 4; i >= 1; i--) {
    ctx.beginPath();
    ctx.arc(sx, sy, r + i * 6, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r + i * 6);
    g.addColorStop(0, `hsla(${h}, ${s}%, ${l}%, ${0.08 * pulse})`);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fill();
  }

  // Avatar body
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  const body = ctx.createRadialGradient(sx - r*0.35, sy - r*0.35, 0, sx, sy, r);
  body.addColorStop(0, `hsl(${h}, ${s}%, ${Math.min(l+25,95)}%)`);
  body.addColorStop(1, `hsl(${h}, ${s}%, ${l}%)`);
  ctx.fillStyle = body;
  ctx.fill();

  // Self ring
  if (isSelf) {
    ctx.beginPath();
    ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${h}, ${s}%, ${l+20}%, ${0.5 * pulse})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Name tag (only for others)
  if (!isSelf) {
    ctx.fillStyle = `hsla(0, 0%, 100%, 0.4)`;
    ctx.font = `8px 'Space Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(p.name, sx, sy - r - 6);
  }
}

function drawPlayers() {
  players.forEach((p) => {
    // Lerp render positions
    if (p.renderX === undefined) { p.renderX = p.targetX; p.renderY = p.targetY; }
    p.renderX += (p.targetX - p.renderX) * 0.15;
    p.renderY += (p.targetY - p.renderY) * 0.15;
    p.x = p.renderX; p.y = p.renderY;
    drawPlayer(p, false);
  });
  if (self) drawPlayer(self, true);
}

// ─── Orb Proximity Check ──────────────────────────────────────────────────────
let nearOrb = null;
let orbPopupTimeout = null;

function checkOrbProximity() {
  if (!self) return;
  let closest = null, closestDist = Infinity;
  orbs.forEach((orb, id) => {
    const dx = orb.x - self.x, dy = orb.y - self.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist < 60 && dist < closestDist) {
      closest = id; closestDist = dist;
    }
  });

  if (closest !== null && closest !== nearOrb) {
    nearOrb = closest;
    playOrbChime();
    const orb = orbs.get(closest);
    if (orb.text) {
      showOrbPopup(closest, orb.text);
    } else {
      socket.emit('orb:read', { id: closest });
    }
  } else if (closest === null && nearOrb !== null) {
    nearOrb = null;
    hideOrbPopup();
  }
}

let currentPopupOrb = null;
function showOrbPopup(id, text) {
  currentPopupOrb = id;
  const popup = document.getElementById('orb-popup');
  const orb = orbs.get(id);

  document.getElementById('orb-text').textContent = `"${text}"`;
  const ago = orb ? timeAgo(orb.createdAt) : '';
  document.getElementById('orb-ago').textContent = ago;

  popup.classList.remove('hidden');
  popup.style.opacity = '1';
  popup.style.display = 'block';
}

function hideOrbPopup() {
  const popup = document.getElementById('orb-popup');
  popup.classList.add('hidden');
  currentPopupOrb = null;
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

// ─── HUD Updates ──────────────────────────────────────────────────────────────
let hudTick = 0;
function updateHUD() {
  if (!self) return;
  hudTick++;
  if (hudTick % 10 === 0) {
    document.getElementById('hud-coords').textContent =
      `${Math.round(self.x)}, ${Math.round(self.y)}`;
  }
}

function updatePresence() {
  const count = players.size + 1;
  document.getElementById('presence-count').textContent = count;
  document.getElementById('presence-label').textContent = count === 1 ? 'soul' : 'souls';
}

// ─── Memory Input ─────────────────────────────────────────────────────────────
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
  document.getElementById('memory-input').blur();
}

function submitMemory() {
  const text = document.getElementById('memory-input').value.trim();
  if (!text) { closeMemory(); return; }
  socket.emit('orb:create', { text });
  playMemorySound();
  closeMemory();
}

document.getElementById('memory-input').addEventListener('input', (e) => {
  const len = e.target.value.length;
  document.getElementById('memory-chars').textContent = 100 - len;
});

document.getElementById('memory-submit').addEventListener('click', submitMemory);

// ─── Mood Picker ──────────────────────────────────────────────────────────────
document.querySelectorAll('.mood-opt').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.mood-opt').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    socket.emit('player:mood', el.dataset.mood);
  });
});

// ─── Keyboard Events ──────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (memoryOpen) {
    if (e.key === 'Escape') closeMemory();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitMemory();
    return;
  }
  keys[e.key] = true;

  if (e.key === 'e' || e.key === 'E') {
    e.preventDefault();
    openMemory();
  }

  if (e.key === 'x' || e.key === 'X') {
    if (nearOrb !== null && myOrbIds.has(nearOrb)) {
      socket.emit('orb:delete', { id: nearOrb });
    }
  }
});

window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
});

// ─── Avatar Customize Screen ──────────────────────────────────────────────────
let chosenColor = '#60a5fa';

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
  grad.addColorStop(0, '#fff');
  grad.addColorStop(1, color);
  px.beginPath();
  px.arc(30, 30, 20, 0, Math.PI * 2);
  px.fillStyle = grad;
  px.fill();
  // glow
  px.beginPath();
  px.arc(30, 30, 26, 0, Math.PI * 2);
  px.strokeStyle = color + '66';
  px.lineWidth = 3;
  px.stroke();
}
drawPreview(chosenColor);

function enterWorld() {
  const nameInput = document.getElementById('custom-name').value.trim();
  const customize = document.getElementById('customize-screen');
  customize.classList.add('fade-out');
  setTimeout(() => { customize.style.display = 'none'; }, 500);
  initAudio();
  // Send chosen name + color to server
  socket.emit('player:join', { name: nameInput, color: chosenColor });
}

document.getElementById('customize-enter').addEventListener('click', enterWorld);
document.getElementById('custom-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterWorld();
});

// ─── Touch/Click Splash Dismiss ───────────────────────────────────────────────
const splash = document.getElementById('splash');
function dismissSplash() {
  splash.classList.add('fade-out');
  setTimeout(() => {
    splash.style.display = 'none';
    // Show customize screen after splash
    document.getElementById('customize-screen').classList.remove('hidden');
    setTimeout(() => document.getElementById('custom-name').focus(), 100);
  }, 900);
}
splash.addEventListener('click', dismissSplash);
splash.addEventListener('touchend', dismissSplash);

// ─── Audio Engine ─────────────────────────────────────────────────────────────
let audioCtx = null;
let masterGain = null;
let isMuted = false;
let dronePlaying = false;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.18;
  masterGain.connect(audioCtx.destination);
  startDrone();
}

function startDrone() {
  if (dronePlaying || !audioCtx) return;
  dronePlaying = true;

  // Layer 1 — deep sub hum
  const osc1 = audioCtx.createOscillator();
  const g1 = audioCtx.createGain();
  osc1.type = 'sine';
  osc1.frequency.value = 55;
  g1.gain.value = 0.4;
  osc1.connect(g1); g1.connect(masterGain);
  osc1.start();

  // Layer 2 — mid shimmer
  const osc2 = audioCtx.createOscillator();
  const g2 = audioCtx.createGain();
  osc2.type = 'sine';
  osc2.frequency.value = 110.5;
  g2.gain.value = 0.15;
  osc2.connect(g2); g2.connect(masterGain);
  osc2.start();

  // Layer 3 — slow LFO wobble on osc2
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  lfo.frequency.value = 0.08;
  lfoGain.gain.value = 3;
  lfo.connect(lfoGain);
  lfoGain.connect(osc2.frequency);
  lfo.start();

  // Soft noise breath
  const bufferSize = audioCtx.sampleRate * 2;
  const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.12;
  const noise = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 180;
  const noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.08;
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(masterGain);
  noise.start();
}

function playOrbChime() {
  if (!audioCtx || isMuted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, t);
  osc.frequency.exponentialRampToValueAtTime(440, t + 0.6);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.25, t + 0.05);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
  osc.connect(env); env.connect(masterGain);
  osc.start(t); osc.stop(t + 0.8);
}

function playMemorySound() {
  if (!audioCtx || isMuted) return;
  const t = audioCtx.currentTime;
  [440, 554, 659].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t + i * 0.12);
    env.gain.linearRampToValueAtTime(0.2, t + i * 0.12 + 0.05);
    env.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 1.2);
    osc.connect(env); env.connect(masterGain);
    osc.start(t + i * 0.12);
    osc.stop(t + i * 0.12 + 1.2);
  });
}

// Mute toggle
document.getElementById('mute-btn').addEventListener('click', () => {
  initAudio();
  isMuted = !isMuted;
  masterGain.gain.value = isMuted ? 0 : 0.18;
  document.getElementById('mute-btn').classList.toggle('muted', isMuted);
  document.getElementById('mute-btn').textContent = isMuted ? '♪' : '♪';
});


let lastTime = 0;
function render(ts) {
  const dt = ts - lastTime; lastTime = ts;
  time++;

  updateMovement(dt);
  updateCamera();
  checkOrbProximity();
  updateHUD();

  drawBackground();
  drawGrid();
  drawOrbPulses();
  drawOrbs();
  drawPlayers();

  requestAnimationFrame(render);
}

requestAnimationFrame(render);
