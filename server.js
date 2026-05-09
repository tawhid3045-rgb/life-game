const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory State ─────────────────────────────────────────────────────────
const players = new Map();  // socketId → { lat, lng, mood, color, name, district }
const memoryOrbs = [];      // { id, lat, lng, text, createdAt, authorId, district }
let orbIdCounter = 0;

const MOODS = { ecstatic:5, happy:4, neutral:3, melancholy:2, lost:1 };
const MOOD_LABELS = Object.keys(MOODS);

const AVATAR_COLORS = [
  '#f9b8d0','#cbb8fd','#a5c8f8','#9de8c0',
  '#fbc99a','#e2c4f8','#a5f3c8','#fda4af'
];

function randomColor() { return AVATAR_COLORS[Math.floor(Math.random()*AVATAR_COLORS.length)]; }
function randomName() {
  const adj = ['drifting','quiet','lost','wandering','soft','hollow','fading','still','gentle','hazy'];
  const noun = ['soul','echo','ghost','signal','pulse','fragment','wave','mist','breath','light'];
  return `${adj[Math.floor(Math.random()*adj.length)]}_${noun[Math.floor(Math.random()*noun.length)]}`;
}
function calcGlobalMood() {
  if (!players.size) return 3;
  let t = 0; players.forEach(p => { t += MOODS[p.mood]||3; });
  return t / players.size;
}
function moodToHue(m) {
  const t = (m-1)/4;
  return Math.round(240 + t*(60-240));
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('player:join', ({ name, color, lat, lng, district }) => {
    const safeName  = (typeof name==='string' && name.trim()) ? name.trim().slice(0,20) : randomName();
    const safeColor = AVATAR_COLORS.includes(color) ? color : randomColor();
    // Default to center of Bangladesh if no location
    const safeLat = (typeof lat==='number' && lat>20 && lat<27) ? lat : 23.6850 + (Math.random()-0.5)*0.5;
    const safeLng = (typeof lng==='number' && lng>88 && lng<93) ? lng : 90.3563 + (Math.random()-0.5)*0.5;

    const player = {
      lat: safeLat, lng: safeLng,
      mood: 'neutral', color: safeColor,
      name: safeName, district: district||'unknown',
      id: socket.id
    };
    players.set(socket.id, player);

    socket.emit('init', {
      self: player,
      players: [...players.values()].map(p=>({...p})),
      orbs: memoryOrbs.map(o=>({ id:o.id,lat:o.lat,lng:o.lng,createdAt:o.createdAt,district:o.district })),
      globalMood: { hue: moodToHue(calcGlobalMood()), mood: calcGlobalMood() }
    });
    socket.broadcast.emit('player:join', { ...player });
  });

  socket.on('player:move', ({ lat, lng }) => {
    const p = players.get(socket.id);
    if (!p) return;
    if (typeof lat!=='number'||typeof lng!=='number') return;
    p.lat = lat; p.lng = lng;
    socket.broadcast.emit('player:moved', { id:socket.id, lat, lng });
  });

  socket.on('player:mood', (mood) => {
    if (!MOOD_LABELS.includes(mood)) return;
    const p = players.get(socket.id);
    if (!p) return;
    p.mood = mood;
    io.emit('world:mood', { hue: moodToHue(calcGlobalMood()), mood: calcGlobalMood() });
  });

  socket.on('orb:create', ({ text, lat, lng, district }) => {
    const p = players.get(socket.id);
    if (!p||!text||typeof text!=='string') return;
    const clean = text.slice(0,100).trim();
    if (!clean) return;
    const orb = {
      id: ++orbIdCounter,
      lat: lat||p.lat, lng: lng||p.lng,
      text: clean, createdAt: Date.now(),
      authorId: socket.id,
      district: district||p.district||'unknown'
    };
    memoryOrbs.push(orb);
    const pub = { id:orb.id, lat:orb.lat, lng:orb.lng, createdAt:orb.createdAt, district:orb.district };
    socket.emit('orb:placed', { ...pub, mine:true });
    socket.broadcast.emit('orb:placed', pub);
  });

  socket.on('orb:read', ({ id }) => {
    const orb = memoryOrbs.find(o=>o.id===id);
    if (!orb) return;
    socket.emit('orb:content', { id:orb.id, text:orb.text, district:orb.district });
  });

  socket.on('orb:delete', ({ id }) => {
    const idx = memoryOrbs.findIndex(o=>o.id===id && o.authorId===socket.id);
    if (idx===-1) return;
    memoryOrbs.splice(idx,1);
    io.emit('orb:deleted', { id });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('player:leave', { id:socket.id });
    io.emit('world:mood', { hue: moodToHue(calcGlobalMood()), mood: calcGlobalMood() });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌍 Life Game (Bangladesh Map) running on http://localhost:${PORT}`);
});
