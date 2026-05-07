const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory World State ──────────────────────────────────────────────────
// Future: replace with MongoDB collections
const players = new Map();       // socketId → { x, y, mood, color, name }
const memoryOrbs = [];           // { id, x, y, text, createdAt, authorId }
let orbIdCounter = 0;

const MOODS = { ecstatic: 5, happy: 4, neutral: 3, melancholy: 2, lost: 1 };
const MOOD_LABELS = Object.keys(MOODS);

function calcGlobalMood() {
  if (players.size === 0) return 3;
  let total = 0;
  players.forEach(p => { total += MOODS[p.mood] || 3; });
  return total / players.size;
}

function globalMoodColor(mood) {
  // Maps 1–5 to a hue: 240(blue/sad) → 60(yellow/happy)
  const t = (mood - 1) / 4; // 0–1
  const hue = Math.round(240 + t * (60 - 240)); // 240 → 60
  return { hue, sat: 70, mood };
}

const AVATAR_COLORS = [
  '#ff6b9d', '#c084fc', '#60a5fa', '#34d399', '#fbbf24',
  '#f87171', '#a78bfa', '#38bdf8', '#4ade80', '#fb923c'
];

function randomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function randomName() {
  const adj = ['drifting', 'quiet', 'lost', 'wandering', 'soft', 'hollow', 'fading', 'still'];
  const noun = ['soul', 'echo', 'ghost', 'signal', 'pulse', 'void', 'fragment', 'wave'];
  return `${adj[Math.floor(Math.random() * adj.length)]}_${noun[Math.floor(Math.random() * noun.length)]}`;
}

// ─── Socket.IO Events ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const startX = Math.floor(Math.random() * 3000) - 1500;
  const startY = Math.floor(Math.random() * 3000) - 1500;

  // Wait for player to send their chosen name/color
  socket.on('player:join', ({ name, color }) => {
    const safeName = (typeof name === 'string' && name.trim())
      ? name.trim().slice(0, 20)
      : randomName();
    const safeColor = AVATAR_COLORS.includes(color) ? color : randomColor();

    const player = { x: startX, y: startY, mood: 'neutral', color: safeColor, name: safeName, id: socket.id };
    players.set(socket.id, player);

    // Send this player their own data + full world state
    socket.emit('init', {
      self: player,
      players: [...players.entries()].map(([id, p]) => ({ ...p, id })),
      orbs: memoryOrbs,
      globalMood: globalMoodColor(calcGlobalMood())
    });

    // Broadcast new player to others
    socket.broadcast.emit('player:join', { ...player, id: socket.id });
  });

  // Position update — throttled on client side
  socket.on('player:move', ({ x, y }) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = x; p.y = y;
    socket.broadcast.emit('player:moved', { id: socket.id, x, y });
  });

  // Mood update
  socket.on('player:mood', (mood) => {
    if (!MOOD_LABELS.includes(mood)) return;
    const p = players.get(socket.id);
    if (!p) return;
    p.mood = mood;
    const gm = globalMoodColor(calcGlobalMood());
    io.emit('world:mood', gm);
  });

  // Memory orb creation
  socket.on('orb:create', ({ text }) => {
    const p = players.get(socket.id);
    if (!p || !text || typeof text !== 'string') return;
    const clean = text.slice(0, 100).trim();
    if (!clean) return;
    const orb = {
      id: ++orbIdCounter,
      x: p.x,
      y: p.y,
      text: clean,
      createdAt: Date.now(),
      authorId: socket.id // never sent to other clients
    };
    memoryOrbs.push(orb);
    // Send to all (strip authorId). Flag as mine only for the author.
    const public_orb = { id: orb.id, x: orb.x, y: orb.y, createdAt: orb.createdAt };
    socket.emit('orb:placed', { ...public_orb, mine: true });       // author gets mine:true
    socket.broadcast.emit('orb:placed', public_orb);                // others get normal
  });

  // Orb read request
  socket.on('orb:read', ({ id }) => {
    const orb = memoryOrbs.find(o => o.id === id);
    if (!orb) return;
    socket.emit('orb:content', { id: orb.id, text: orb.text });
  });

  // Orb delete — only author can delete
  socket.on('orb:delete', ({ id }) => {
    const idx = memoryOrbs.findIndex(o => o.id === id && o.authorId === socket.id);
    if (idx === -1) return; // not found or not the author
    memoryOrbs.splice(idx, 1);
    io.emit('orb:deleted', { id }); // tell all clients to remove it
  });

  // Disconnect
  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('player:leave', { id: socket.id });
    const gm = globalMoodColor(calcGlobalMood());
    io.emit('world:mood', gm);
  });
});

const PORT = process.env.PORT || 8080;
console.log(`Starting server on PORT: ${PORT}`);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌌 Life Game server running on http://localhost:${PORT}`);
});
