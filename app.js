import * as G from './game.js';

const $ = (id) => document.getElementById(id);
const PREFIX = 'bjp2p-fede-';

let isHost = false;
let myId = null;
let game = null; // solo host
let view = null; // estado público que se dibuja
let hostConn = null; // solo cliente
const conns = new Map(); // host: peerId -> conn

// ---------- Lobby ----------
const params = new URLSearchParams(location.search);
if (params.get('sala')) $('code').value = params.get('sala');
$('name').value = localStorage.getItem('bj-name') || '';

function getName() {
  const n = $('name').value.trim();
  if (!n) { $('lobbyErr').textContent = 'Poné tu nombre'; return null; }
  try { localStorage.setItem('bj-name', n); } catch {}
  return n;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = new Uint32Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => chars[x % chars.length]).join('');
}

$('create').onclick = () => {
  const name = getName();
  if (!name) return;
  const code = randomCode();
  $('lobbyErr').textContent = 'Creando sala...';
  const peer = new Peer(PREFIX + code);
  peer.on('open', (id) => {
    isHost = true;
    myId = id;
    game = G.createGame();
    G.addPlayer(game, myId, name);
    enterGame(code);
    broadcast();
  });
  peer.on('connection', (conn) => {
    conn.on('data', (msg) => onClientMsg(conn, msg));
    conn.on('close', () => {
      conns.delete(conn.peer);
      if (game.players[conn.peer]) { G.disconnectPlayer(game, conn.peer); broadcast(); }
    });
  });
  peer.on('error', (e) => { $('lobbyErr').textContent = 'Error: ' + e.type; $('err').textContent = 'Error de red: ' + e.type; });
};

$('join').onclick = () => {
  const name = getName();
  const code = $('code').value.trim().toUpperCase();
  if (!name) return;
  if (!code) { $('lobbyErr').textContent = 'Poné el código'; return; }
  $('lobbyErr').textContent = 'Conectando...';
  const peer = new Peer();
  peer.on('open', (id) => {
    myId = id;
    hostConn = peer.connect(PREFIX + code, { reliable: true });
    hostConn.on('open', () => hostConn.send({ t: 'join', name }));
    hostConn.on('data', (msg) => {
      if (msg.t === 'state') {
        if ($('game').classList.contains('hidden')) enterGame(code);
        setView(msg.state, msg.timer);
      } else if (msg.t === 'error') {
        if ($('game').classList.contains('hidden')) $('lobbyErr').textContent = msg.error;
        else $('err').textContent = msg.error;
      }
    });
    hostConn.on('close', () => { $('err').textContent = 'Se cortó la conexión con el host. Recargá para reconectar (conservás tus fichas).'; });
  });
  peer.on('error', (e) => {
    const t = e.type === 'peer-unavailable' ? 'No existe esa sala (o el host se fue)' : 'Error: ' + e.type;
    $('lobbyErr').textContent = t;
    $('err').textContent = t;
  });
};

function enterGame(code) {
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('roomCode').textContent = code;
  $('netInfo').textContent = isHost ? '(sos el host: no cierres esta pestaña)' : '';
  const link = location.origin + location.pathname + '?sala=' + code;
  $('copy').onclick = () => navigator.clipboard.writeText(link).then(() => ($('copy').textContent = '¡Copiado!'));
}

// ---------- Host ----------
function onClientMsg(conn, msg) {
  const id = conn.peer;
  let err = null;
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') {
    err = G.addPlayer(game, id, msg.name);
    if (err) { conn.send({ t: 'error', error: err }); setTimeout(() => conn.close(), 500); return; }
    conns.set(id, conn);
  } else if (!game.players[id] || !conns.has(id)) {
    return;
  } else {
    err = handle(id, msg);
  }
  if (err) conn.send({ t: 'error', error: err });
  broadcast();
}

function handle(id, msg) {
  switch (msg.t) {
    case 'bet': return G.placeBet(game, id, msg.amount);
    case 'act': return G.act(game, id, msg.a);
    case 'rebuy': return G.rebuy(game, id);
    default: return 'Mensaje inválido';
  }
}

// ---------- Automático: la partida corre sola con tiempos ----------
const TIMES = { bet: 15000, dealNow: 1500, turn: 20000, done: 6000 };
let timer = null;
let timerKey = null;
let timerKind = null;
let timerDeadline = 0;

function schedule() {
  let key = null, kind = null, ms = 0, fn = null;
  if (game.phase === 'betting') {
    const st = G.bettingStatus(game);
    if (st.anyBet && st.allDecided) {
      key = 'dealNow:' + game.roundNo; kind = 'dealNow'; ms = TIMES.dealNow; fn = G.deal;
    } else if (st.anyBet) {
      key = 'bet:' + game.roundNo; kind = 'bet'; ms = TIMES.bet; fn = G.deal;
    }
  } else if (game.phase === 'playing' && game.turn) {
    const h = game.players[game.turn.pid].hands[game.turn.hand];
    // el reloj se reinicia con cada acción (cambia la cantidad de cartas o la mano)
    key = `turn:${game.roundNo}:${game.turn.pid}:${game.turn.hand}:${h.cards.length}`;
    kind = 'turn'; ms = TIMES.turn;
    fn = (g) => {
      const name = g.players[g.turn.pid].name;
      G.forceStand(g);
      if (g.phase === 'playing') g.message = `${name} no jugó a tiempo: se plantó`;
    };
  } else if (game.phase === 'done') {
    key = 'done:' + game.roundNo; kind = 'done'; ms = TIMES.done; fn = G.nextRound;
  }
  if (key === timerKey) return;
  clearTimeout(timer);
  timerKey = key;
  timerKind = kind;
  timerDeadline = key ? Date.now() + ms : 0;
  if (key) timer = setTimeout(() => {
    timerKey = timerKind = null;
    timerDeadline = 0;
    fn(game);
    broadcast();
  }, ms);
}

function broadcast() {
  schedule();
  const state = G.publicState(game);
  const t = { kind: timerKind, ms: timerDeadline ? timerDeadline - Date.now() : 0 };
  for (const c of conns.values()) if (c.open) c.send({ t: 'state', state, timer: t });
  setView(state, t);
}

let timerView = { kind: null, end: 0, total: 0 };
function setView(state, t) {
  view = state;
  // se manda el tiempo restante (no la hora) para no depender de relojes desincronizados
  timerView = t && t.kind ? { kind: t.kind, end: Date.now() + t.ms, total: TIMES[t.kind] } : { kind: null, end: 0, total: 0 };
  render();
}

// Acciones del jugador local (host o cliente)
function send(msg) {
  $('err').textContent = '';
  if (isHost) {
    const err = handle(myId, msg);
    if (err) $('err').textContent = err;
    broadcast();
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
  const red = c.s === '♥' || c.s === '♦' ? ' red' : '';
  return `<div class="card${red}${anim}"><div class="tl">${c.r}<small>${c.s}</small></div><div class="mid">${c.s}</div></div>`;
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

function render() {
  const s = view;
  if (!s) return;
  const me = s.players[myId];
  const dCards = s.dealer.cards;
  $('dealer').innerHTML = dCards.length ? dCards.map(cardHtml('d')).join('') : '<div class="empty-slot"></div><div class="empty-slot" style="margin-left:8px"></div>';
  $('dealerVal').innerHTML = s.dealer.hidden
    ? `<span class="badge">${valText(dCards.filter(Boolean))} + ?</span>`
    : badge(dCards, dCards.length === 2 && G.isNatural({ cards: dCards }));
  $('msg').textContent = s.message;
  $('shoe').textContent = `Ronda ${s.roundNo} · ${s.shoeLeft}/${s.shoeSize} cartas en el zapato`;

  const betting = s.phase === 'betting';
  $('betRow').classList.toggle('hidden', !betting);
  const legal = G.legalActions(s, myId);
  document.querySelectorAll('#actRow button').forEach((b) => (b.disabled = !legal.includes(b.dataset.a)));
  const myTurn = legal.length > 0;
  $('actRow').classList.toggle('hidden', !myTurn);
  $('actRow').classList.toggle('myturn', myTurn);
  let wait = '';
  if (s.phase === 'playing' && !myTurn && s.turn) wait = `Juega ${esc(s.players[s.turn.pid].name)}...`;
  if (s.phase === 'playing' && !s.round.includes(myId)) wait = 'No jugás esta mano. Entrás en la próxima.';
  if (betting && me && me.bet) wait = `Apostaste <b>${me.bet}</b>. Podés cambiarla hasta que se reparta.`;
  if (betting && me && me.sitOut) wait = 'Pasás esta mano.';
  $('waitTxt').innerHTML = wait;
  $('waitTxt').classList.toggle('hidden', !wait);
  if (me) $('rebuy').classList.toggle('hidden', !(betting && me.chips < s.rules.minBet));
  renderTimer();

  $('players').innerHTML = s.seats
    .map((id) => {
      const p = s.players[id];
      const isTurnP = s.turn && s.turn.pid === id;
      const hands = p.hands
        .map((h, i) => {
          const cls = isTurnP && s.turn.hand === i ? 'hand turn' : 'hand';
          const res = h.result ? `<span class="res res-${h.result}">${RES[h.result]}${h.payout ? ' +' + h.payout : ''}</span>` : '';
          return `<div class="${cls}"><div class="cards">${h.cards.map(cardHtml(id + ':' + i)).join('')}</div>
            <div class="hand-info"><span>${badge(h.cards, G.isNatural(h))} ● ${h.bet}${h.doubled ? ' ×2' : ''}</span>${res}</div></div>`;
        })
        .join('');
      let sub = '';
      if (!p.connected) sub = 'desconectado';
      else if (s.phase === 'betting') sub = p.bet ? `✓ apuesta ${p.bet}` : p.sitOut ? 'pasa' : 'decidiendo...';
      else if (!s.round.includes(id)) sub = 'mira esta mano';
      else if (isTurnP) sub = '<b style="color:var(--gold)">★ su turno</b>';
      const cls = ['panel', 'seat', isTurnP && 'active', id === myId && 'me', !p.connected && 'off'].filter(Boolean).join(' ');
      return `<div class="${cls}"><div class="seat-head"><span class="pname">${esc(p.name)}</span><span class="stack">${p.chips}</span></div>
        <div class="seat-sub">${sub}</div>${hands}</div>`;
    })
    .join('');
}

document.querySelectorAll('.chip').forEach((b) => {
  b.onclick = () => {
    const cur = Number($('bet').value) || 0;
    const max = view && view.players[myId] ? view.players[myId].chips : Infinity;
    $('bet').value = Math.min(cur + Number(b.dataset.v), Math.floor(max / 10) * 10);
  };
});
$('clearBet').onclick = () => ($('bet').value = 0);
