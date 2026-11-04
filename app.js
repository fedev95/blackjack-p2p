import * as G from './game.js';
import { Verifier } from './verify.js';
import { PEER_OPTIONS } from './net-config.js';

const $ = (id) => document.getElementById(id);
const PREFIX = 'bjp2p-fede-';

let isHost = false;
let myId = null; // id de jugador (opaco, lo asigna el host; no es el id de red)
let game = null; // solo host
let view = null; // estado público que se dibuja
let hostConn = null; // solo cliente
let verifier = null; // solo cliente
let roomCode = null;
let myName = null;
let hostPeer = null; // host: su conexión al servidor de señalización
let clientPeer = null; // cliente: ídem
let migrating = false; // buscando host nuevo

// ---------- Utilidades ----------
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const isPin = (p) => /^\d{6}$/.test(p);
function randomPin() {
  const b = new Uint32Array(1);
  let x;
  do { crypto.getRandomValues(b); x = b[0]; } while (x >= 4294000000); // sin sesgo
  return String(x % 1000000).padStart(6, '0');
}
function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos: sin sesgo de módulo
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => chars[x % 32]).join('');
}
// comparación en tiempo constante
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- Lobby ----------
const params = new URLSearchParams(location.search);
if (params.get('sala')) $('code').value = params.get('sala').toUpperCase();
$('name').value = lsGet('bj-name') || '';
$('newPin').value = randomPin();

// Si recargaste la página estando en una sala, volver a entrar solo (la pestaña recuerda la sala).
let autoRejoin = false;
try {
  const active = sessionStorage.getItem('bj-active-room');
  const sala = (params.get('sala') || '').toUpperCase();
  if (active && active === sala && lsGet('bj-room-' + sala) && $('name').value) autoRejoin = true;
} catch {}

document.querySelectorAll('input[name=vis]').forEach((r) => (r.onchange = () => {
  const priv = document.querySelector('input[name=vis]:checked').value === 'private';
  $('newPinRow').classList.toggle('hidden', !priv);
  $('visHelp').textContent = priv
    ? 'Solo entra quien tenga el código y el PIN. Pasá el PIN por otro lado (no en el mismo mensaje del link).'
    : 'Entra cualquiera que tenga el link o el código.';
}));

function getName() {
  const n = G.cleanName($('name').value);
  if (!n) { $('lobbyErr').textContent = 'Poné tu nombre'; return null; }
  lsSet('bj-name', n);
  return n;
}

function lobbyBusy(b) {
  $('create').disabled = b;
  $('join').disabled = b;
}

// ---------- Host ----------
const LIMITS = {
  pendingMs: 10000, // tiempo para identificarse antes de cortar la conexión
  maxPending: 10, // conexiones sin identificar a la vez
  msgWindowMs: 2000,
  msgMax: 30, // mensajes por ventana; más que eso = flood, se corta
  pinFailWindowMs: 60000,
  pinFailMax: 5, // intentos fallidos de PIN por minuto (en total)
};
const conns = new Map(); // playerId -> conn
let room = { private: false, pin: null };
const pinFails = [];
let pending = 0;

$('create').onclick = () => {
  const name = getName();
  if (!name) return;
  const priv = document.querySelector('input[name=vis]:checked').value === 'private';
  const pin = $('newPin').value.trim();
  if (priv && !isPin(pin)) { $('lobbyErr').textContent = 'El PIN tiene que ser de 6 números'; return; }
  const code = randomCode();
  $('lobbyErr').textContent = 'Creando sala...';
  lobbyBusy(true);
  const peer = new Peer(PREFIX + code, PEER_OPTIONS);
  peer.on('open', () => {
    if (isHost) return; // reconexión al servidor de señalización
    roomCode = code;
    room = { private: priv, pin: priv ? pin : null };
    myName = name;
    // el host también guarda su token: si se va y vuelve con el link, entra como jugador con sus fichas
    const token = G.randomHex(16);
    lsSet('bj-room-' + code, { token, pin: priv ? pin : '' });
    const g = G.createGame({ p2p: true });
    myId = G.joinPlayer(g, name, token, G.randomHex(8)).id;
    g.hostId = myId;
    G.setTableColor(g, lsGet('bj-table-color') || 'green'); // el último color que eligió
    enterGame();
    startHosting(peer, g);
  });
  peer.on('error', (e) => {
    if (isHost) return;
    lobbyBusy(false);
    $('lobbyErr').textContent = e.type === 'unavailable-id' ? 'Ese código ya existe, probá de nuevo' : 'Error de red: ' + e.type;
  });
};

// Empieza a coordinar la mesa (al crear la sala o al tomarla porque el host anterior se fue).
function startHosting(peer, g) {
  isHost = true;
  hostPeer = peer;
  game = g;
  verifier = null;
  hostConn = null;
  conns.clear();
  pending = 0;
  queue = Promise.resolve();
  revealWait = null;
  timerKey = null;
  peer.on('connection', onConnection);
  // si se corta la señalización, las partidas en curso siguen; reintentamos para aceptar nuevos jugadores
  peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 2000); });
  peer.on('error', (e) => {
    if (e.type !== 'peer-unavailable') $('err').textContent = 'Error de red: ' + e.type;
  });
  setupHostUI();
  broadcast();
}

// Latido del host: si los jugadores dejan de recibirlo, saben que se fue aunque WebRTC tarde en avisar
setInterval(() => {
  if (!isHost) return;
  for (const c of conns.values()) if (c.open) c.send({ t: 'ping' });
}, 2000);

// Al cerrar la pestaña, el host se despide y libera el código de sala para que otro lo tome enseguida
window.addEventListener('pagehide', () => {
  if (!isHost) return;
  for (const c of conns.values()) if (c.open) c.send({ t: 'bye' });
  if (hostPeer) hostPeer.destroy();
});

// Cliente: sin noticias del host por 7 s = se fue
let lastHostMsg = 0;
setInterval(() => {
  if (isHost || migrating || !hostConn || !myId) return;
  if (Date.now() - lastHostMsg > 7000) {
    const c = hostConn;
    hostConn = null;
    c.close();
    onHostLost();
  }
}, 1000);

function onConnection(conn) {
  if (pending >= LIMITS.maxPending) {
    conn.on('open', () => conn.close());
    return;
  }
  pending++;
  let counted = true;
  const unpend = () => { if (counted) { counted = false; pending--; } };
  const info = { pid: null, times: [] };
  const kill = setTimeout(() => { if (!info.pid) conn.close(); }, LIMITS.pendingMs);

  conn.on('data', (msg) => {
    const now = Date.now();
    info.times.push(now);
    while (info.times.length && now - info.times[0] > LIMITS.msgWindowMs) info.times.shift();
    if (info.times.length > LIMITS.msgMax) { conn.close(); return; }
    if (!msg || typeof msg !== 'object') return;
    // las revelaciones se atienden al toque: la cola está esperando justamente por ellas
    if (msg.t === 'reveal') {
      if (info.pid && conns.get(info.pid) === conn) onReveal(info.pid, msg);
      return;
    }
    enqueue(async () => {
      await onClientMsg(conn, info, msg);
      if (info.pid) { unpend(); clearTimeout(kill); }
    });
  });
  conn.on('close', () => {
    unpend();
    clearTimeout(kill);
    if (!info.pid) return;
    if (revealWait && conns.get(info.pid) === conn && revealWait.need.delete(info.pid) && !revealWait.need.size) revealWait.resolve();
    enqueue(async () => {
      if (conns.get(info.pid) !== conn) return;
      conns.delete(info.pid);
      const pid = info.pid;
      const onTurn = game.phase === 'playing' && game.turn && game.turn.pid === pid;
      await runStep((g) => G.disconnectPlayer(g, pid), game.roundLog ? game.roundLog.actions.length : 0, onTurn ? { pid, a: 'stand' } : null);
      broadcast();
    });
  });
}

// ---------- Cola: los pasos del juego se ejecutan de a uno ----------
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error(e));
  return queue;
}

// Ejecuta un paso del motor. Si necesita una carta que todavía no salió, la sortea con todos y reintenta.
// act/pending: la jugada que va a consumir la carta (se anuncia ANTES de sortearla).
async function runStep(fn, act, pending) {
  for (;;) {
    const snap = G.snapshot(game);
    try {
      return fn(game);
    } catch (e) {
      if (e !== G.NEED_CARD) throw e;
      G.restore(game, snap);
      const n = game.phase === 'dealing' && game.cards.length === 0 ? G.initialCards(game) : 1;
      await collect(n, act, pending);
    }
  }
}

// Sorteo de n cartas: cada participante revela el siguiente eslabón de su cadena.
const REVEAL_MS = 5000;
let revealWait = null;
async function collect(n, act, pending) {
  const k = game.cards.length;
  const round = game.roundNo;
  const got = new Map([[G.HOST, G.hostReveals(game, k, n)]]);
  const need = new Set(G.activeContributors(game.fair, k).filter((c) => c !== G.HOST));
  await new Promise((resolve) => {
    revealWait = { round, k, n, got, need, resolve };
    for (const c of [...need]) {
      const conn = conns.get(c);
      if (conn && conn.open) conn.send({ t: 'reveal?', round, k, n, act, pending });
      else need.delete(c);
    }
    if (!need.size) return resolve();
    setTimeout(resolve, REVEAL_MS); // quien no responde a tiempo queda fuera del sorteo de esta mano
  });
  revealWait = null;
  for (const c of G.activeContributors(game.fair, k)) if (!got.has(c)) G.dropContributor(game, c, k);
  for (let i = 0; i < n; i++) {
    const vals = {};
    for (const c of G.activeContributors(game.fair, game.cards.length)) vals[c] = got.get(c)[i];
    G.pushCard(game, vals);
  }
  broadcast();
}

function onReveal(pid, msg) {
  const w = revealWait;
  if (!w || msg.round !== w.round || msg.k !== w.k || !w.need.has(pid)) return;
  if (!Array.isArray(msg.values) || msg.values.length !== w.n || !G.checkReveals(game, pid, w.k, msg.values)) return;
  w.got.set(pid, msg.values);
  w.need.delete(pid);
  if (!w.need.size) w.resolve();
}

async function onClientMsg(conn, info, msg) {
  if (typeof msg.t !== 'string') return;
  if (!info.pid) {
    if (msg.t !== 'join') return;
    const reject = (error, extra = {}) => {
      conn.send({ t: 'error', error, fatal: true, ...extra });
      setTimeout(() => conn.close(), 300);
    };
    if (typeof msg.name !== 'string' || msg.name.length > 60) return reject('Nombre inválido');
    if (room.private) {
      const now = Date.now();
      while (pinFails.length && now - pinFails[0] > LIMITS.pinFailWindowMs) pinFails.shift();
      if (pinFails.length >= LIMITS.pinFailMax) return reject('Demasiados intentos fallidos de PIN. Esperá un minuto.', { needPin: true });
      if (typeof msg.pin !== 'string' || msg.pin === '') return reject('Esta sala es privada: ingresá el PIN.', { needPin: true });
      if (!safeEqual(msg.pin, room.pin)) {
        pinFails.push(now);
        return reject('PIN incorrecto.', { needPin: true });
      }
    }
    const r = G.joinPlayer(game, msg.name, msg.token, G.randomHex(8));
    if (r.error) return reject(r.error);
    const old = conns.get(r.id);
    info.pid = r.id;
    conns.set(r.id, conn);
    if (old && old !== conn) {
      // la sesión vieja (otra pestaña o recarga) queda afuera, y se le avisa para que no busque otro host
      if (old.open) old.send({ t: 'error', error: 'Entraste a la mesa desde otra pestaña o dispositivo.', fatal: true, replaced: true });
      setTimeout(() => old.close(), 300);
    }
    conn.send({ t: 'welcome', id: r.id, private: room.private });
    broadcast();
    return;
  }
  if (conns.get(info.pid) !== conn) return;
  const err = await handle(info.pid, msg);
  if (err && msg.t !== 'anchor') conn.send({ t: 'error', error: err });
  broadcast();
}

async function handle(id, msg) {
  switch (msg.t) {
    case 'bet': return G.placeBet(game, id, msg.amount);
    case 'rebuy': return G.rebuy(game, id);
    case 'anchor': return G.submitAnchor(game, id, msg.round, msg.anchor);
    case 'buy':
      if (typeof msg.item !== 'string' || typeof msg.to !== 'string') return 'Compra inválida';
      return G.buyItem(game, id, msg.item, msg.to);
    case 'drop': return G.dropItem(game, id);
    case 'act': {
      const a = msg.a;
      if (typeof a !== 'string' || !G.legalActions(game, id).includes(a)) return 'Acción no permitida';
      return runStep((g) => G.act(g, id, a), game.roundLog.actions.length, { pid: id, a });
    }
    default: return 'Mensaje inválido';
  }
}

// ---------- Cliente ----------
$('join').onclick = async () => {
  const name = getName();
  const code = $('code').value.trim().toUpperCase();
  if (!name) return;
  if (!/^[A-Z0-9]{4,10}$/.test(code)) { $('lobbyErr').textContent = 'Código de sala inválido'; return; }
  const pinTyped = $('joinPin').value.trim();
  if (pinTyped && !isPin(pinTyped)) { $('lobbyErr').textContent = 'El PIN tiene que ser de 6 números'; return; }
  // credenciales por sala: token secreto para reconectar (y el PIN si ya entraste antes)
  const creds = lsGet('bj-room-' + code) || { token: G.randomHex(16), pin: '' };
  if (pinTyped) creds.pin = pinTyped;
  $('lobbyErr').textContent = 'Conectando...';
  lobbyBusy(true);
  const r = await joinRoom(code, name, creds, autoRejoin ? 8000 : 15000);
  if (r === 'ok') return;
  // volviste a una sala y no quedó nadie coordinándola: la rearmás vos con el último estado guardado
  if (autoRejoin && (r === 'unavailable' || r === 'timeout') && (await restoreRoom(code, name, creds))) return;
  lobbyBusy(false);
  if (r === 'timeout')
    $('lobbyErr').textContent =
      'No se pudo conectar con el host. Revisá que el código sea correcto y que la sala siga abierta. ' +
      'Si están en redes distintas, puede ser la red: probá con otro wifi o con datos móviles.';
  else if (r === 'unavailable') $('lobbyErr').textContent = 'No existe esa sala (o el host se fue)';
  else if (r.error) {
    $('lobbyErr').textContent = r.error;
    if (r.needPin) {
      $('joinPinRow').classList.remove('hidden');
      $('joinPin').focus();
      lsSet('bj-room-' + code, { ...creds, pin: '' });
    }
  }
};

// Se conecta al host de la sala. Resuelve 'ok', 'timeout', 'unavailable' o { error, needPin }.
// Se usa al entrar y también para reconectarse si el host cambia.
function joinRoom(code, name, creds, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (r !== 'ok') peer.destroy();
      resolve(r);
    };
    const peer = new Peer(PEER_OPTIONS);
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    peer.on('connection', (c) => c.close()); // los jugadores solo hablan con el host
    peer.on('error', (e) => done(e.type === 'peer-unavailable' ? 'unavailable' : { error: 'Error de red: ' + e.type }));
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true });
      conn.on('open', () => conn.send({ t: 'join', name, token: creds.token, pin: creds.pin || '' }));
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (hostConn === conn || msg.t === 'welcome') lastHostMsg = Date.now();
        if (msg.t === 'ping') return;
        if (msg.t === 'bye') {
          if (hostConn === conn) {
            hostConn = null;
            onHostLost();
          }
          return;
        }
        if (msg.t === 'welcome' && typeof msg.id === 'string') {
          if (clientPeer && clientPeer !== peer) clientPeer.destroy();
          clientPeer = peer;
          hostConn = conn;
          roomCode = code;
          myName = name;
          room = { private: !!msg.private, pin: creds.pin || null };
          lsSet('bj-room-' + code, creds);
          const send = (m) => hostConn === conn && conn.open && conn.send(m);
          if (verifier && myId === msg.id) verifier.send = send; // reconexión: el verificador sigue igual
          else verifier = new Verifier(msg.id, send);
          myId = msg.id;
          enterGame();
          setTimeout(showConnType, 3000);
          done('ok');
        } else if (hostConn !== conn) {
          if (msg.t === 'error') done({ error: String(msg.error).slice(0, 200), needPin: !!msg.needPin });
        } else if (msg.t === 'state' && msg.state) {
          verifier.onState(msg.state);
          setView(msg.state, msg.timer);
        } else if (msg.t === 'reveal?') {
          const values = verifier.onRevealRequest(msg);
          if (values) conn.send({ t: 'reveal', round: msg.round, k: msg.k, values });
          else renderFair();
        } else if (msg.t === 'error') {
          $('err').textContent = String(msg.error).slice(0, 200);
          if (msg.replaced) conn.replaced = true;
          actLock = null;
          render();
        }
      });
      conn.on('close', () => {
        if (hostConn !== conn || isHost) return;
        if (conn.replaced) return; // entramos desde otra pestaña: no hay que buscar otro host
        onHostLost();
      });
    });
  });
}

// ---------- El host se fue: otro jugador toma la mesa ----------
// Todos tienen el mismo último estado, así que coinciden en quién sigue: el primer jugador conectado
// en el orden de la mesa. Ese intenta quedarse con el código de sala; los demás se reconectan al mismo
// código. Si el elegido tampoco aparece, a los 8 s lo intenta el siguiente, y así.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sirve tanto si el host se fue como si se cortó tu propia conexión: en los dos casos hay que volver a
// encontrar la mesa (el mismo código de sala). Sin internet no gasta intentos: espera a que vuelva.
let wakeUp = null; // corta la espera entre intentos cuando vuelve internet
window.addEventListener('online', () => wakeUp && wakeUp());
const nap = (ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  wakeUp = () => {
    clearTimeout(t);
    r();
  };
});

function reconnectUI(on, text) {
  document.body.classList.toggle('reconnecting', on);
  $('reconnect').classList.toggle('hidden', !on);
  if (text !== undefined) $('reconnectTxt').textContent = text;
  $('retryBtn').classList.add('hidden');
}

async function onHostLost() {
  if (migrating || isHost) return;
  migrating = true;
  const last = view;
  const oldHost = last && last.players[last.hostId];
  const code = roomCode;
  const creds = lsGet('bj-room-' + code) || {};
  hostConn = null;
  const order = last ? last.seats.filter((id) => id !== last.hostId && last.players[id] && last.players[id].connected) : [];
  const k = order.indexOf(myId);
  const start = Date.now();
  let offlineMs = 0; // el tiempo sin internet no cuenta para decidir quién toma la mesa
  const tick = setInterval(() => {
    const secs = Math.round((Date.now() - start) / 1000);
    $('reconnectTxt').textContent = navigator.onLine
      ? `Se cortó la conexión con la mesa. Reconectando… (${secs} s)`
      : 'Sin internet. Vuelvo a la mesa apenas vuelva la conexión…';
  }, 500);
  reconnectUI(true, 'Se cortó la conexión con la mesa. Reconectando…');
  const finish = (ok, text) => {
    clearInterval(tick);
    migrating = false;
    if (ok) {
      reconnectUI(false);
      $('err').textContent = '';
    } else {
      reconnectUI(true, text);
      $('retryBtn').classList.remove('hidden');
    }
  };
  while (Date.now() - start < 180000) {
    if (!navigator.onLine) {
      const t0 = Date.now();
      await nap(5000);
      offlineMs += Date.now() - t0;
      continue;
    }
    // tomar la mesa solo si me toca y estoy online (si el que se cortó soy yo, el código sigue ocupado)
    if (k >= 0 && last && Date.now() - start - offlineMs >= k * 8000) {
      const peer = await claimRoom(code);
      if (peer) {
        becomeHost(peer, last, oldHost);
        return finish(true);
      }
    }
    const r = await joinRoom(code, myName, creds, 5000);
    if (r === 'ok') return finish(true);
    if (r && r.error) return finish(false, r.error);
    await nap(1500);
  }
  finish(false, 'No se pudo volver a la mesa.');
}

// Intenta quedarse con el código de sala. Falla si el host anterior todavía lo tiene.
function claimRoom(code) {
  return new Promise((resolve) => {
    const peer = new Peer(PREFIX + code, PEER_OPTIONS);
    const timer = setTimeout(() => {
      peer.destroy();
      resolve(null);
    }, 6000);
    peer.on('open', () => {
      clearTimeout(timer);
      resolve(peer);
    });
    peer.on('error', () => {
      clearTimeout(timer);
      peer.destroy();
      resolve(null);
    });
  });
}

function becomeHost(peer, last, oldHost) {
  if (clientPeer) clientPeer.destroy();
  clientPeer = null;
  const { game: g, voided } = G.fromState(last, myId);
  const me = g.players[myId];
  const was = oldHost && oldHost.id !== myId ? `${oldHost.name} se fue` : 'Se rearmó la mesa';
  g.message = voided
    ? `${was}: la mano se anuló y se devolvieron las apuestas. Ahora coordina ${me.name}`
    : `${was}. Ahora coordina ${me.name}`;
  const creds = lsGet('bj-room-' + roomCode) || {};
  room = { private: room.private, pin: room.private ? creds.pin || null : null };
  $('err').textContent = '';
  enterGame();
  startHosting(peer, g);
}

async function restoreRoom(code, name, creds) {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem('bj-state-' + code));
  } catch {}
  if (!saved || !saved.state || !saved.myId || !saved.state.players[saved.myId]) return false;
  const peer = await claimRoom(code);
  if (!peer) return false;
  myId = saved.myId;
  roomCode = code;
  myName = name;
  room = { private: !!saved.private, pin: creds.pin || null };
  becomeHost(peer, saved.state, saved.state.players[saved.state.hostId]);
  return true;
}

// Muestra en el modal ⓘ si la conexión con el host es directa o pasa por un servidor de respaldo.
async function showConnType() {
  const pc = hostConn && hostConn.peerConnection;
  if (!pc || !pc.getStats) return;
  try {
    const stats = await pc.getStats();
    let type = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
        const local = stats.get(r.localCandidateId);
        const remote = stats.get(r.remoteCandidateId);
        if (local) type = local.candidateType === 'relay' || (remote && remote.candidateType === 'relay') ? 'relay' : 'direct';
      }
    });
    if (type) $('netInfo').textContent = type === 'relay' ? 'Conexión con el host: por servidor de respaldo (TURN)' : 'Conexión con el host: directa';
  } catch {}
}

function enterGame() {
  document.body.classList.add('in-game');
  // la URL queda con el código de sala y la pestaña lo recuerda: si recargás, volvés a entrar solo
  try {
    history.replaceState(null, '', location.pathname + '?sala=' + roomCode);
    sessionStorage.setItem('bj-active-room', roomCode);
  } catch {}
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('roomCode').textContent = roomCode;
  $('roomVis').textContent = room.private ? '🔒 Privada' : '🌐 Pública';
  if (!isHost) $('netInfo').textContent = '';
  const link = location.origin + location.pathname + '?sala=' + roomCode;
  $('copy').onclick = () =>
    navigator.clipboard.writeText(link).then(() => {
      $('copy').textContent = '✓ Copiado';
      setTimeout(() => ($('copy').textContent = '🔗 Copiar link'), 1800);
    });
}

// Controles que solo tiene el que coordina la mesa
function setupHostUI() {
  $('netInfo').textContent = 'Coordinás la mesa. Si cerrás la pestaña, otro jugador toma tu lugar.';
  $('infoBtn').classList.remove('alert');
  $('colorPick').classList.remove('hidden');
  document.querySelectorAll('#colorPick button').forEach((b) => {
    b.onclick = () => enqueue(() => {
      if (G.setTableColor(game, b.dataset.c)) return;
      lsSet('bj-table-color', b.dataset.c);
      broadcast();
    });
  });
  if (room.private && room.pin) {
    $('showPin').classList.remove('hidden');
    $('showPin').onclick = () => {
      const shown = $('showPin').dataset.shown === '1';
      $('showPin').dataset.shown = shown ? '0' : '1';
      $('showPin').textContent = shown ? 'Ver PIN' : 'PIN: ' + room.pin;
    };
  }
}

// ---------- Automático: la partida corre sola con tiempos ----------
const TIMES = { bet: 15000, dealNow: 1500, turn: 20000, done: 6000 };
let timer = null;
let timerKey = null;
let timerKind = null;
let timerTotal = 0;
let timerDeadline = 0;

function schedule() {
  let key = null, kind = null, ms = 0, fn = null;
  if (game.phase === 'betting') {
    const st = G.bettingStatus(game);
    if (st.anyBet && st.allDecided) {
      key = 'dealNow:' + game.roundNo; kind = 'dealNow'; ms = TIMES.dealNow; fn = startRound;
    } else if (st.anyBet) {
      key = 'bet:' + game.roundNo; kind = 'bet'; ms = TIMES.bet; fn = startRound;
    }
  } else if (game.phase === 'playing' && game.turn) {
    const turnKey = () => {
      const h = game.players[game.turn.pid].hands[game.turn.hand];
      return `turn:${game.roundNo}:${game.turn.pid}:${game.turn.hand}:${h.cards.length}`;
    };
    // el reloj se reinicia con cada acción (cambia la cantidad de cartas o la mano)
    key = turnKey();
    kind = 'turn'; ms = TIMES.turn;
    if (game.roundLog.actions.length === 0) ms += DEAL_STEP_MS * (2 * game.round.length + 1); // tiempo del reparto en pantalla
    const expected = key;
    fn = async () => {
      if (game.phase !== 'playing' || !game.turn || turnKey() !== expected) return;
      const pid = game.turn.pid;
      const name = game.players[pid].name;
      await runStep(G.forceStand, game.roundLog.actions.length, { pid, a: 'stand' });
      if (game.phase === 'playing') game.message = `${name} no jugó a tiempo: se plantó`;
    };
  } else if (game.phase === 'done') {
    // la pausa del resultado se alarga lo que tarda la banca en mostrar sus cartas de a una
    key = 'done:' + game.roundNo; kind = 'done'; ms = TIMES.done + DEALER_STEP_MS * Math.max(0, game.dealer.cards.length - 1);
    fn = async () => G.nextRound(game);
  }
  if (key === timerKey) return;
  clearTimeout(timer);
  timerKey = key;
  timerKind = kind;
  timerTotal = ms;
  timerDeadline = key ? Date.now() + ms : 0;
  if (key) timer = setTimeout(() => {
    timerKey = timerKind = null;
    timerDeadline = 0;
    enqueue(async () => {
      await fn();
      broadcast();
    });
  }, ms);
}

async function startRound() {
  if (G.beginRound(game)) return;
  broadcast(); // todos ven quiénes participan del sorteo antes de la primera carta
  await runStep(G.dealInitial, -1, null);
}

function broadcast() {
  schedule();
  const state = G.publicState(game);
  const t = { kind: timerKind, ms: timerDeadline ? timerDeadline - Date.now() : 0, total: timerTotal };
  for (const c of conns.values()) if (c.open) c.send({ t: 'state', state, timer: t });
  setView(state, t);
}

let timerView = { kind: null, end: 0, total: 0 };
function setView(state, t) {
  view = state;
  // la pestaña guarda el último estado: si recargás y no queda nadie coordinando, la mesa se rearma con esto
  try {
    sessionStorage.setItem('bj-state-' + roomCode, JSON.stringify({ state, myId, private: room.private }));
  } catch {}
  // se manda el tiempo restante (no la hora) para no depender de relojes desincronizados
  timerView = t && t.kind ? { kind: t.kind, end: Date.now() + t.ms, total: num(t.total) || TIMES[t.kind] } : { kind: null, end: 0, total: 0 };
  trackDeal(state);
  trackDealer(state);
  render();
}

// Acciones del jugador local (host o cliente)
let actLock = null; // evita mandar dos jugadas mientras se sortea la carta de la primera
function send(msg) {
  $('err').textContent = '';
  if (msg.t === 'buy' && verifier) verifier.noteBuy(msg.item, msg.to);
  if (msg.t === 'act') {
    actLock = view && view.roundLog ? `${view.roundNo}:${view.roundLog.actions.length}` : null;
    if (verifier) verifier.noteAction(msg.a);
    render();
  }
  if (isHost) {
    enqueue(async () => {
      const err = await handle(myId, msg);
      if (err) {
        $('err').textContent = err;
        actLock = null;
      }
      broadcast();
    });
  } else if (hostConn && hostConn.open) {
    hostConn.send(msg);
  }
}

$('betBtn').onclick = () => send({ t: 'bet', amount: Number($('bet').value) });
$('sitOut').onclick = () => send({ t: 'bet', amount: 0 });
$('rebuy').onclick = () => send({ t: 'rebuy' });
document.querySelectorAll('#actRow button').forEach((b) => (b.onclick = () => send({ t: 'act', a: b.dataset.a })));

function renderTimer() {
  const el = $('timer');
  const s = view;
  if (!s) return;
  const left = Math.max(0, timerView.end - Date.now());
  const secs = Math.ceil(left / 1000);
  let txt = '';
  if (timerView.kind === 'bet') txt = `Se reparte en ${secs}s · ¡apostá!`;
  else if (timerView.kind === 'dealNow') txt = '¡Repartiendo!';
  else if (timerView.kind === 'turn' && s.turn) txt = s.turn.pid === myId ? `Tu turno · ${secs}s` : `Turno de ${s.players[s.turn.pid].name} · ${secs}s`;
  else if (timerView.kind === 'done') txt = `Próxima mano en ${secs}s`;
  else if (s.phase === 'betting') txt = 'Esperando la primera apuesta...';
  el.querySelector('span').textContent = txt;
  const bar = el.querySelector('i');
  bar.style.width = timerView.kind && timerView.total ? (100 * left) / timerView.total + '%' : '0%';
  el.classList.toggle('urgent', timerView.kind === 'turn' && secs <= 5);
}
setInterval(renderTimer, 200);

// ---------- Render ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const seen = new Set(); // cartas ya dibujadas (para animar solo las nuevas)
const cardHtml = (key) => (c, i) => {
  const k = `${view.roundNo}|${key}|${i}|${c ? c.r + c.s : 'x'}`;
  const anim = seen.has(k) ? '' : ' deal';
  seen.add(k);
  if (!c) return `<div class="card back${anim}"></div>`;
  // solo valores conocidos: nada de lo que mande el host se inserta como HTML crudo
  const r = G.RANKS.includes(c.r) ? c.r : '?';
  const su = G.SUITS.includes(c.s) ? c.s : '?';
  const red = su === '♥' || su === '♦' ? ' red' : '';
  return `<div class="card${red}${anim}"><div class="tl">${r}<small>${su}</small></div><div class="mid">${su}</div></div>`;
};
const valText = (cards) => {
  if (!cards.length || cards.includes(null)) return '';
  const v = G.handValue(cards);
  return v.soft && v.total < 21 ? `${v.total - 10}/${v.total}` : String(v.total);
};
const badge = (cards, natural) => {
  const t = valText(cards);
  if (!t) return '';
  const total = G.handValue(cards.filter(Boolean)).total;
  if (natural) return '<span class="badge bj">BJ</span>';
  return `<span class="badge${total > 21 ? ' bust' : ''}">${total > 21 ? total + ' ✕' : t}</span>`;
};
const RES = { win: 'Gana', lose: 'Pierde', push: 'Empate', blackjack: '¡Blackjack!' };
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const fmt = (n) => num(n).toLocaleString('es-AR');

// ---------- La banca saca sus cartas de a una ----------
// El estado llega con la mano ya resuelta; acá solo se dosifica lo que se muestra: las cartas de la banca
// aparecen de a una y los resultados, pagos y fichas nuevas recién cuando terminó.
const DEALER_STEP_MS = 800;
let dealerAnim = { round: -1, shown: 0, timer: null };

function trackDealer(s) {
  const n = s.dealer.cards.length;
  if (s.phase === 'dealing' || s.phase === 'playing') {
    if (dealerAnim.timer) clearInterval(dealerAnim.timer);
    dealerAnim = { round: s.roundNo, shown: n, timer: null };
  } else if (s.phase === 'done') {
    if (dealerAnim.round !== s.roundNo) dealerAnim = { round: s.roundNo, shown: n, timer: null }; // llegué tarde: sin animación
    else if (dealerAnim.shown < n && !dealerAnim.timer) {
      dealerAnim.timer = setInterval(() => {
        if (dealing()) return; // primero termina el reparto inicial
        dealerAnim.shown++;
        if (!view || dealerAnim.shown >= view.dealer.cards.length) {
          clearInterval(dealerAnim.timer);
          dealerAnim.timer = null;
        }
        render();
      }, DEALER_STEP_MS);
    }
  }
}

// ---------- Reparto inicial de a una carta ----------
// Las cartas iniciales se sortean juntas (un solo ida y vuelta por la red), pero se muestran como en el
// casino: una a cada jugador, la de la banca y la segunda a cada jugador, de a una.
const DEAL_STEP_MS = 250;
let dealAnim = { round: -1, shown: Infinity, total: 0, timer: null, seenDealing: false };

function trackDeal(s) {
  if (s.phase === 'dealing') {
    if (dealAnim.round !== s.roundNo) {
      if (dealAnim.timer) clearInterval(dealAnim.timer);
      dealAnim = { round: s.roundNo, shown: 0, total: 0, timer: null, seenDealing: true };
    }
    return;
  }
  if (s.phase !== 'playing' && s.phase !== 'done') return;
  if (dealAnim.round !== s.roundNo) {
    dealAnim = { round: s.roundNo, shown: Infinity, total: 0, timer: null, seenDealing: false }; // llegué tarde
    return;
  }
  if (dealAnim.seenDealing && !dealAnim.timer && dealAnim.shown === 0) {
    dealAnim.total = 2 * s.round.length + 1;
    dealAnim.timer = setInterval(() => {
      dealAnim.shown++;
      if (dealAnim.shown >= dealAnim.total) {
        clearInterval(dealAnim.timer);
        dealAnim.timer = null;
        dealAnim.shown = Infinity;
      }
      render();
    }, DEAL_STEP_MS);
  }
}
const dealing = () => dealAnim.shown !== Infinity && dealAnim.round === (view && view.roundNo);

const dealerPlaying = (s) => s.phase === 'done' && dealerAnim.round === s.roundNo && dealerAnim.shown < s.dealer.cards.length;

// Copia del estado para mostrar mientras la banca juega: sin resultados ni pagos todavía.
function presentState(s) {
  const dealingNow = dealing();
  if (!dealerPlaying(s) && !dealingNow) return s;
  const d = JSON.parse(JSON.stringify(s));
  if (dealingNow) {
    // orden de casino: índice 0..n-1 primera carta de cada jugador, n la banca, n+1.. la segunda
    const n = d.round.length;
    d.round.forEach((id, j) => {
      const h = d.players[id] && d.players[id].hands[0];
      if (!h || d.players[id].hands.length > 1) return;
      h.cards = h.cards.filter((_, k) => (k === 0 ? j : k === 1 ? n + 1 + j : Infinity) < dealAnim.shown);
    });
    d.dealer.cards = dealAnim.shown > n ? d.dealer.cards.slice(0, 1) : [];
    d.message = 'Repartiendo…';
    d.turn = null;
    if (!dealerPlaying(s)) return d;
  }
  if (!dealingNow) {
    d.dealer.cards = d.dealer.cards.slice(0, Math.max(1, Math.min(dealerAnim.shown, d.dealer.cards.length)));
    d.message = 'La banca juega…';
  }
  for (const id of d.round) {
    const p = d.players[id];
    if (!p) continue;
    for (const h of p.hands) {
      p.chips -= num(h.payout);
      h.result = null;
      h.payout = 0;
    }
  }
  return d;
}

function render() {
  if (!view) return;
  const s = presentState(view);
  const me = s.players[myId];
  const dCards = s.dealer.cards;
  const slot = '<div class="empty-slot" style="margin-left:8px"></div>';
  // regla europea: la 2ª carta de la banca sale recién al final
  $('dealer').innerHTML = dCards.length ? dCards.map(cardHtml('d')).join('') + (dCards.length === 1 && s.phase !== 'done' ? slot : '') : '<div class="empty-slot"></div>' + slot;
  $('dealerVal').innerHTML = badge(dCards, dCards.length === 2 && !dealerPlaying(view) && G.isNatural({ cards: dCards }));
  $('msg').textContent = s.message;
  $('shoe').textContent = `Ronda ${s.roundNo} · 6 mazos, mezcla continua · cartas sorteadas entre todos`;

  const betting = s.phase === 'betting';
  $('betRow').classList.toggle('hidden', !betting);
  if (me) $('myChips').textContent = fmt(me.chips);
  const legal = G.legalActions(s, myId);
  const locked = dealing() || (actLock !== null && s.roundLog && actLock === `${s.roundNo}:${s.roundLog.actions.length}`);
  if (!locked) actLock = null;
  document.querySelectorAll('#actRow button').forEach((b) => (b.disabled = locked || !legal.includes(b.dataset.a)));
  const myTurn = legal.length > 0;
  $('actRow').classList.toggle('hidden', !myTurn);
  $('actRow').classList.toggle('myturn', myTurn);
  let wait = '';
  if (s.phase === 'playing' && !myTurn && s.turn) wait = `Juega ${esc(s.players[s.turn.pid].name)}...`;
  if (s.phase === 'dealing') wait = 'Sorteando cartas entre todos...';
  if (locked) wait = 'Sorteando tu carta...';
  if (s.phase === 'playing' && !s.round.includes(myId)) wait = 'No jugás esta mano. Entrás en la próxima.';
  if (betting && me && me.bet) wait = `Apostaste <b>${num(me.bet)}</b>. Podés cambiarla hasta que se reparta.`;
  if (betting && me && me.sitOut) wait = 'Pasás esta mano.';
  $('waitTxt').innerHTML = wait;
  $('waitTxt').classList.toggle('hidden', !wait);
  if (me) $('rebuy').classList.toggle('hidden', !(betting && me.chips < s.rules.minBet));
  renderTimer();
  renderFair();

  renderSeats(s);
  checkToast(s);
  renderShop();
  const color = G.TABLE_COLORS.includes(s.tableColor) ? s.tableColor : 'green';
  $('table').dataset.color = color;
  document.querySelectorAll('#colorPick button').forEach((b) => b.classList.toggle('on', b.dataset.c === color));
}

// Posición de cada lugar sobre el arco de la mesa (en % del ancho y alto de la mesa).
// El primero en jugar va a la derecha (a la izquierda de la banca, como en el casino).
function seatPositions(n) {
  const narrow = $('table').clientWidth < 560;
  // arco amplio: los lugares quedan cerca del borde de madera y el centro libre
  const rx = narrow ? 40 : 43.5;
  const cy = narrow ? 2 : 3;
  const ry = narrow ? 86 : 81;
  const span = n <= 1 ? 0 : Math.min(narrow ? 128 : 136, 30 * (n - 1));
  return Array.from({ length: n }, (_, i) => {
    const deg = 90 - span / 2 + (n <= 1 ? 0 : (span * i) / (n - 1));
    const th = (deg * Math.PI) / 180;
    return { x: 50 + rx * Math.cos(th), y: cy + ry * Math.sin(th) };
  });
}

// Tamaño y superposición de las cartas de cada lugar. Las tuyas grandes; las de los demás más chicas
// y apiladas (se ve la esquina con el valor). Todo se compacta más con varias manos o muchas cartas.
function seatScale(isMe, hands, othersCards) {
  const narrow = $('table').clientWidth < 560; // en celular las cartas ya son chicas: se achican menos
  let scale = isMe ? 1 : narrow ? 0.82 : 0.72;
  let ov = isMe ? -0.52 : -0.68;
  if (hands.length === 2) scale *= 0.88;
  else if (hands.length >= 3) scale *= 0.74;
  const most = hands.reduce((m, h) => Math.max(m, h.cards.length), 0);
  if (most >= 4) ov -= 0.08;
  if (most >= 6) ov -= 0.08;
  if (!isMe && othersCards > 18 && !narrow) scale *= 0.88; // mesa con muchas cartas (en celular ya están al mínimo)
  return { scale: scale.toFixed(3), ov: ov.toFixed(2) };
}

// ---------- Tienda ----------
const CIGAR_SVG =
  '<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="rotate(-32 32 34)">' +
  '<rect x="4" y="28" width="48" height="12" rx="6" fill="#7a4a24"/><rect x="6" y="29" width="44" height="3" rx="1.5" fill="#a56a3a" opacity=".8"/>' +
  '<rect x="36" y="27" width="6" height="14" fill="#d4a62a"/><rect x="48" y="28.5" width="9" height="11" rx="4" fill="#a8adb3"/>' +
  '<circle cx="58" cy="34" r="3" fill="#ff7a1a"/></g>' +
  '<path d="M50 18c5-4-1-8 4-13" stroke="#cfcfcf" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".7"/></svg>';
const iconHtml = (it) => (it.icon === 'cigar' ? CIGAR_SVG : `<span class="emo">${it.icon}</span>`);
const handsLeft = (item, s) => item.until - s.roundNo + (s.phase === 'playing' || s.phase === 'dealing' ? 1 : 0);

const leftText = (item, s) => {
  const left = Math.max(1, handsLeft(item, s));
  return left === 1 ? 'última mano' : `quedan ${left} manos`;
};

function itemBubble(p, s) {
  const it = p.item && G.shopItem(p.item.id);
  if (!it) return '';
  const from = p.item.from && s.players[p.item.from];
  const title = `${it.name}${from ? ' · regalo de ' + from.name : ''} · ${leftText(p.item, s)}`;
  return `<span class="itm" title="${esc(title)}">${iconHtml(it)}${from ? '<i class="gift">🎁</i>' : ''}</span>`;
}

let shopTo = null;
let lastToastSeq = null;
// Modales (tienda e información): se cierran con la ✕, tocando afuera o con Escape
function openModal(id) {
  document.querySelectorAll('.modal').forEach((m) => m.classList.toggle('hidden', m.id !== id));
  if (id === 'shop') renderShop();
}
const closeModal = (id) => $(id).classList.add('hidden');
document.querySelectorAll('.modal').forEach((m) => (m.onclick = (e) => e.target === m && closeModal(m.id)));
document.querySelectorAll('.modal-close').forEach((b) => (b.onclick = () => closeModal(b.dataset.close)));
document.addEventListener('keydown', (e) => e.key === 'Escape' && document.querySelectorAll('.modal').forEach((m) => closeModal(m.id)));
// La tienda se abre para uno mismo (🛒) o tocando a un jugador en la mesa (para regalarle)
function openShopFor(id) {
  shopTo = id;
  openModal('shop');
}
$('shopBtn').onclick = () => openShopFor(myId);
$('seats').onclick = (e) => {
  const seat = e.target.closest('.seat[data-pid]');
  if (seat && view && view.players[seat.dataset.pid]) openShopFor(seat.dataset.pid);
};
$('infoBtn').onclick = () => openModal('info');

// Los controles están fijos abajo: el contenido deja ese espacio libre
new ResizeObserver(() => document.documentElement.style.setProperty('--ctrl-h', $('controls').offsetHeight + 'px')).observe($('controls'));

function renderShop() {
  const s = view;
  if (!s || $('shop').classList.contains('hidden')) return;
  const me = s.players[myId];
  if (!me) return;
  const others = s.seats.filter((id) => id !== myId);
  if (!shopTo || (shopTo !== myId && !others.includes(shopTo))) shopTo = myId;
  $('shopFor').innerHTML =
    shopTo === myId
      ? `<span>Para vos</span><small>Para regalar, tocá a un jugador en la mesa</small>`
      : `<span>🎁 Regalo para <b>${esc(s.players[shopTo].name)}</b></span><button id="shopForMe" class="ghost">Para mí</button>`;
  if (shopTo !== myId) $('shopForMe').onclick = () => openShopFor(myId);
  const open = s.phase === 'betting' || s.phase === 'done';
  const free = me.chips - (s.phase === 'betting' ? num(me.bet) : 0);
  $('shopChips').textContent = `${fmt(free)} fichas disponibles`;
  const target = s.players[shopTo];
  let status = '';
  if (!open) status = 'La tienda abre entre manos: mientras se apuesta o al terminar la mano.';
  else if (target && target.item) status = shopTo === myId ? 'Ya tenés un consumible. Terminalo para comprar otro.' : `${target.name} ya tiene un consumible (uno a la vez).`;
  $('shopStatus').textContent = status;

  const mine = me.item && G.shopItem(me.item.id);
  $('shopMine').innerHTML = mine
    ? `<div class="mine"><span class="itm big">${iconHtml(mine)}</span><span>Tenés <b>${mine.name}</b>${me.item.from && s.players[me.item.from] ? ' (regalo de ' + esc(s.players[me.item.from].name) + ')' : ''} · ${leftText(me.item, s)}</span><button id="dropItem" class="ghost">Terminar</button></div>`
    : '';
  if (mine) $('dropItem').onclick = () => send({ t: 'drop' });

  const cats = [...new Set(G.SHOP.map((it) => it.cat))];
  $('shopGrid').innerHTML = cats
    .map((cat) => {
      const items = G.SHOP.filter((it) => it.cat === cat)
        .map((it) => {
          const can = open && target && !target.item && free >= it.price;
          const meta = `${it.rounds} mano${it.rounds === 1 ? '' : 's'}`;
          return `<div class="sitem"><div class="sicon">${iconHtml(it)}</div><div class="sname">${it.name}</div>
            <div class="smeta">${meta}</div>
            <button data-item="${it.id}" ${can ? '' : 'disabled'}>● ${it.price}</button></div>`;
        })
        .join('');
      return `<h4>${cat}</h4><div class="sgrid">${items}</div>`;
    })
    .join('');
  $('shopGrid').querySelectorAll('button[data-item]').forEach((b) => {
    b.onclick = () => send({ t: 'buy', item: b.dataset.item, to: shopTo });
  });

  const feed = (s.shopLog || []).filter((e) => e.kind !== 'rebuy').slice(-5).reverse().map(shopLine).filter(Boolean);
  $('shopFeed').innerHTML = feed.length ? '<h4>Últimas compras</h4>' + feed.map((l) => `<div>${l}</div>`).join('') : '';
}

// Frases del pedido de fichas: el host elige el índice con rebuyDraw (verificable), acá solo el texto.
const REBUY_LINES = [
  '{usuario} entregó el marrón por {fichas} fichas',
  '{usuario} se comió toda la leche del crupier y pegó {fichas} fichas',
  '{usuario} le abrió los cachetes al bot y ligó {fichas} fichas',
  '{usuario} se dejó romper bien el culo por {fichas} fichas',
  '{usuario} le hizo un pete con traga adentro al crupier por {fichas} fichas',
  '{usuario} vendió a la vieja por {fichas} fichas',
  '{usuario} bajó la cabeza, cobró de callado y se llevó {fichas} fichas',
  '{usuario} se regaló con moño y todo por {fichas} fichas',
  '{usuario} prestó la rosca para cobrar {fichas} fichas',
  '{usuario} entregó las nalgas sin asco y sacó {fichas} fichas',
  '{usuario} vendió un riñón en el mercado negro y ligó {fichas} fichas',
  '{usuario} empeñó la alianza del abuelo y sacó {fichas} fichas',
  '{usuario} le robó la limosna a la iglesia y juntó {fichas} fichas',
  '{usuario} le sacó el monedero a la abuela y cobró {fichas} fichas',
  '{usuario} vendió la bici del primo y se llevó {fichas} fichas',
  '{usuario} rompió el chanchito de la hermana y consiguió {fichas} fichas',
  '{usuario} le hizo el cuento del tío al crupier y peló {fichas} fichas',
  '{usuario} vendió el auto sin papeles y sacó {fichas} fichas',
  '{usuario} tiró un centro a la nada y enganchó {fichas} fichas',
  '{usuario} le sacó la garrafa al vecino y ligó {fichas} fichas',
  '{usuario} acreditó {fichas} fichas',
  '{usuario} juntó {fichas} fichas',
  '{usuario} desbloqueó {fichas} fichas',
  '{usuario} cobró {fichas} fichas',
  '{usuario} acumuló {fichas} fichas',
  '{usuario} recibió una recompensa de {fichas} fichas',
  '{usuario} agarró {fichas} fichas',
  '{usuario} incorporó {fichas} fichas a su saldo',
  '{usuario} sacó {fichas} fichas',
  '{usuario} ligó {fichas} fichas',
  '{usuario} recibió {fichas} fichas',
  '{usuario} consiguió {fichas} fichas',
  '{usuario} acaba de ganar {fichas} fichas',
  '{usuario} obtuvo {fichas} fichas',
  '{usuario} sumó {fichas} fichas a su billetera',
  '{usuario} recibió un bono de {fichas} fichas',
  '{usuario} se llevó {fichas} fichas',
  '{usuario} reclamó {fichas} fichas',
  '{usuario} sumó {fichas} fichas',
  '{usuario} encontró {fichas} fichas',
];

function shopLine(e) {
  const s = view;
  if (e.kind === 'rebuy') {
    const p = s.players[e.pid];
    const tpl = REBUY_LINES[e.line];
    if (!p || !tpl) return '';
    return '💸 ' + tpl.replace('{usuario}', `<b>${esc(p.name)}</b>`).replace('{fichas}', `<b class="gold">${fmt(e.amount)}</b>`);
  }
  const it = G.shopItem(e.item);
  const buyer = s.players[e.buyer];
  const to = s.players[e.to];
  if (!it || !buyer || !to) return '';
  const icon = it.icon === 'cigar' ? '<span class="inl">' + CIGAR_SVG + '</span>' : it.icon;
  if (e.item === 'cumaso' && e.buyer === e.to) {
    return e.buyer === myId ? `${icon} Te cumiaste todo` : `${icon} <b>${esc(buyer.name)}</b> se cumió todo`;
  }
  return e.buyer === e.to
    ? `<b>${esc(buyer.name)}</b> se compró ${icon} ${it.name}`
    : `<b>${esc(buyer.name)}</b> le regaló ${icon} ${it.name} a <b>${esc(to.name)}</b>`;
}

// Aviso en la mesa cuando alguien compra o regala algo
let toastTimer = null;
function checkToast(s) {
  const log = s.shopLog || [];
  if (lastToastSeq === null) {
    log.forEach(addFeed); // al entrar: lo reciente va al feed, sin avisos
    lastToastSeq = s.shopSeq || 0;
    return;
  }
  const fresh = log.filter((e) => e.seq > lastToastSeq);
  if (!fresh.length) return;
  lastToastSeq = fresh[fresh.length - 1].seq;
  fresh.forEach(addFeed);
  for (const e of fresh) {
    if (e.item === 'cumaso' && e.to === myId && s.players[e.buyer]) splash(e.buyer === myId ? null : s.players[e.buyer].name);
  }
  const line = shopLine(fresh[fresh.length - 1]);
  if (!line) return;
  $('toast').innerHTML = line;
  $('toast').classList.remove('show');
  void $('toast').offsetWidth; // reinicia la animación
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}

// ---------- Efecto del cumaso ----------
// Líquido espeso: las formas se dibujan sueltas y un filtro SVG las funde (gooey) y les da brillo
// húmedo (iluminación especular). Cada impacto tiene una dirección: las salpicaduras se estiran hacia
// ahí y los chorros caen con la gravedad.
let splashN = 0;
const rnd = (a, b) => a + Math.random() * (b - a);
const f1 = (x) => x.toFixed(1);

function splatShapes(cx, cy, r) {
  let out = `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}"/>`;
  // masa irregular alrededor del centro
  for (let i = 0; i < 6; i++) {
    const a = rnd(0, Math.PI * 2);
    const d = r * rnd(0.35, 0.7);
    out += `<circle cx="${f1(cx + Math.cos(a) * d)}" cy="${f1(cy + Math.sin(a) * d)}" r="${f1(r * rnd(0.45, 0.7))}"/>`;
  }
  // salpicaduras estiradas en la dirección del impacto, con gotas cada vez más chicas
  const dir = rnd(0, Math.PI * 2);
  const streaks = 5 + Math.floor(rnd(0, 5));
  for (let i = 0; i < streaks; i++) {
    const a = dir + rnd(-1.1, 1.1);
    const len = r * rnd(1.1, 2.4);
    const w = r * rnd(0.12, 0.26);
    const mx = cx + Math.cos(a) * (r * 0.6 + len / 2);
    const my = cy + Math.sin(a) * (r * 0.6 + len / 2);
    const deg = (a * 180) / Math.PI;
    out += `<ellipse cx="${f1(mx)}" cy="${f1(my)}" rx="${f1(len / 2)}" ry="${f1(w)}" transform="rotate(${f1(deg)} ${f1(mx)} ${f1(my)})"/>`;
    let dist = r * 0.6 + len + w * 2;
    let dr = w * rnd(0.9, 1.3);
    for (let j = 0; j < 3 && dr > 2; j++) {
      out += `<circle cx="${f1(cx + Math.cos(a) * dist)}" cy="${f1(cy + Math.sin(a) * dist)}" r="${f1(dr)}"/>`;
      dist += dr * rnd(2.4, 4);
      dr *= rnd(0.5, 0.75);
    }
  }
  // gotitas sueltas
  for (let i = 0; i < 8; i++) {
    const a = rnd(0, Math.PI * 2);
    const d = r * rnd(1.4, 3.2);
    out += `<circle cx="${f1(cx + Math.cos(a) * d)}" cy="${f1(cy + Math.sin(a) * d)}" r="${f1(rnd(2.5, 7))}"/>`;
  }
  // chorreados: angostos arriba, gota gorda en la punta
  const drips = 1 + Math.floor(rnd(0, 3.5));
  let dripSvg = '';
  for (let j = 0; j < drips; j++) {
    const x = cx + rnd(-r * 0.6, r * 0.6);
    const w = rnd(7, 15);
    const h = innerHeight * rnd(0.1, 0.32);
    const top = cy + r * 0.3;
    const d =
      `M ${f1(x - w / 2)} ${f1(top)} C ${f1(x - w / 2)} ${f1(top + h * 0.5)} ${f1(x - w * 0.3)} ${f1(top + h * 0.8)} ${f1(x - w * 0.75)} ${f1(top + h)} ` +
      `A ${f1(w * 0.8)} ${f1(w * 0.85)} 0 1 0 ${f1(x + w * 0.75)} ${f1(top + h)} ` +
      `C ${f1(x + w * 0.3)} ${f1(top + h * 0.8)} ${f1(x + w / 2)} ${f1(top + h * 0.5)} ${f1(x + w / 2)} ${f1(top)} Z`;
    dripSvg += `<path class="drip" d="${d}" style="animation-delay:${f1(rnd(0.5, 1.4))}s;animation-duration:${f1(rnd(2.6, 4.2))}s"/>`;
  }
  return { out, dripSvg };
}

function splash(fromName) {
  const id = 'liq' + ++splashN;
  // medidas en píxeles de la pantalla: en celular las manchas no quedan diminutas
  const W = innerWidth;
  const H = innerHeight;
  const unit = Math.min(W, H);
  let body = '';
  const count = W < 600 ? 5 + Math.floor(rnd(0, 3)) : 6 + Math.floor(rnd(0, 4));
  for (let k = 0; k < count; k++) {
    const cx = rnd(W * 0.06, W * 0.94);
    const cy = rnd(H * 0.04, H * 0.7);
    const r = unit * rnd(0.045, 0.085);
    const { out, dripSvg } = splatShapes(cx, cy, r);
    const delay = f1(k * 0.11 + rnd(0, 0.12));
    body += `<g class="splat" style="animation-delay:${delay}s;transform-origin:${f1(cx)}px ${f1(cy)}px">${out}${dripSvg}</g>`;
  }
  const el = document.createElement('div');
  el.className = 'splash';
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <defs>
      <filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur"/>
        <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11" result="goo"/>
        <feGaussianBlur in="goo" stdDeviation="3.5" result="soft"/>
        <feSpecularLighting in="soft" surfaceScale="7" specularConstant="1.15" specularExponent="32" lighting-color="#ffffff" result="spec">
          <feDistantLight azimuth="235" elevation="52"/>
        </feSpecularLighting>
        <feComposite in="spec" in2="goo" operator="in" result="specIn"/>
        <feDiffuseLighting in="soft" surfaceScale="4" diffuseConstant="1" lighting-color="#ffffff" result="diff">
          <feDistantLight azimuth="235" elevation="60"/>
        </feDiffuseLighting>
        <feComposite in="goo" in2="diff" operator="arithmetic" k1="0.42" k2="0.66" k3="0" k4="0" result="shaded"/>
        <feComposite in="shaded" in2="goo" operator="in" result="body"/>
        <feComposite in="specIn" in2="body" operator="over"/>
      </filter>
    </defs>
    <g filter="url(#${id})" fill="#fbf8ec">${body}</g>
  </svg><div class="splash-title"></div>`;
  el.querySelector('.splash-title').textContent = fromName ? `${fromName} te cumeó todo` : 'Te cumiaste todo';
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  document.body.classList.remove('shake');
  void document.body.offsetWidth;
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 600);
  setTimeout(() => el.classList.add('out'), 5600);
  setTimeout(() => el.remove(), 7000);
}

// Feed fijo en la esquina (abajo a la izquierda): pedidos de fichas y consumibles, los últimos 6.
function addFeed(e) {
  const line = shopLine(e);
  if (!line) return;
  const item = document.createElement('div');
  item.className = 'feed-item';
  item.innerHTML = line;
  $('feed').appendChild(item);
  while ($('feed').children.length > 6) $('feed').firstChild.remove();
  // se va solo: 12 s visible y medio segundo de salida
  setTimeout(() => {
    item.classList.add('out');
    setTimeout(() => item.remove(), 650);
  }, 12000);
}

function renderSeats(s) {
  const pos = seatPositions(s.seats.length);
  $('table').classList.toggle('crowded', s.seats.length >= 6); // mesa llena: cartas un poco más chicas
  const othersCards = s.seats.filter((id) => id !== myId).reduce((a, id) => a + s.players[id].hands.reduce((b, h) => b + h.cards.length, 0), 0);
  $('seats').innerHTML = s.seats
    .map((id, idx) => {
      const p = s.players[id];
      const isTurnP = s.turn && s.turn.pid === id;
      const hands = p.hands
        .map((h, i) => {
          const cls = isTurnP && s.turn.hand === i ? 'hand turn' : 'hand';
          const refund = h.result === 'lose' && num(h.payout) > 0; // contra Blackjack de la banca se devuelve lo extra
          const label = refund ? `Pierde · vuelve ${num(h.payout)}` : `${RES[h.result]}${num(h.payout) ? ' +' + num(h.payout) : ''}`;
          const res = RES[h.result] ? `<span class="res res-${h.result}">${label}</span>` : '';
          return `<div class="${cls}">${res}<div class="cards">${h.cards.map(cardHtml(id + ':' + i)).join('')}</div>
            <div class="hand-info">${badge(h.cards, G.isNatural(h))}${h.doubled ? '<span class="badge">×2</span>' : ''}</div></div>`;
        })
        .join('');
      const wager = p.hands.length ? p.hands.reduce((a, h) => a + num(h.bet), 0) : num(p.bet);
      let sub = '';
      if (!p.connected) sub = 'desconectado';
      else if (s.phase === 'betting') sub = p.bet ? '✓ listo' : p.sitOut ? 'pasa' : 'apostando...';
      else if (!s.round.includes(id)) sub = 'mira esta mano';
      else if (isTurnP) sub = '<b style="color:var(--gold)">★ su turno</b>';
      const cls = ['seat', isTurnP && 'active', id === myId && 'me', !p.connected && 'off'].filter(Boolean).join(' ');
      const { x, y } = pos[idx];
      const { scale, ov } = seatScale(id === myId, p.hands, othersCards);
      const tip = id === myId ? 'Tienda' : `Regalarle algo a ${p.name}`;
      return `<div class="${cls}" data-pid="${esc(id)}" title="${esc(tip)}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;--cw:calc(var(--tcw) * ${scale});--ov:${ov}">
        <div class="hands">${hands}</div>
        <div class="spot">${wager ? `<div class="betchip">${wager}</div>` : ''}</div>
        <div class="tagrow"><div class="tag"><span class="nm">${esc(p.name)}</span><span class="ch">${fmt(p.chips)}</span></div>${itemBubble(p, s)}</div>
        <div class="sub">${sub}</div>
      </div>`;
    })
    .join('');
}

window.addEventListener('resize', () => view && render());

document.querySelectorAll('.chip').forEach((b) => {
  b.onclick = () => {
    const cur = Number($('bet').value) || 0;
    const max = view && view.players[myId] ? view.players[myId].chips : Infinity;
    if (b.id === 'allIn') setBet(max);
    else setBet(Math.min(cur + Number(b.dataset.v), max));
  };
});
$('clearBet').onclick = () => setBet(0);

// Apuesta: múltiplo de 10 y el campo se agranda según la cantidad de dígitos
function setBet(v) {
  $('bet').value = Math.max(0, Math.floor(num(v) / 10) * 10);
  fitBet();
}
function fitBet() {
  const digits = String($('bet').value || '').length;
  $('bet').style.width = Math.max(4, digits + 2) + 'ch';
}
$('bet').addEventListener('input', fitBet);
fitBet();

let alertShown = false;
function renderFair() {
  const el = $('fair');
  if (isHost) {
    $('fairSum').textContent = '🛡 Sos el host: los demás verifican cada mano que repartís';
    el.classList.add('ok');
    return;
  }
  if (!verifier) return;
  const bad = verifier.alerts.length > 0;
  el.classList.toggle('bad', bad);
  el.classList.toggle('ok', !bad);
  $('infoBtn').classList.toggle('alert', bad);
  if (bad) {
    $('fairSum').textContent = '⚠ Posible trampa del host';
    if (!alertShown) {
      alertShown = true; // la primera alerta abre el modal sola, para que nunca pase desapercibida
      openModal('info');
    }
  } else {
    const r = verifier.roundsOk;
    $('fairSum').textContent = `🛡 Juego limpio · ${r} mano${r === 1 ? '' : 's'} y ${verifier.cardsOk} cartas verificadas`;
  }
  $('fairAlerts').innerHTML =
    verifier.alerts.map((a) => `<div>${esc(a)}</div>`).join('') +
    verifier.notices.map((a) => `<div class="notice">${esc(a)}</div>`).join('');
}

$('retryBtn').onclick = () => onHostLost();
if (autoRejoin) {
  $('lobbyErr').textContent = 'Volviendo a la sala…';
  $('join').click();
}
