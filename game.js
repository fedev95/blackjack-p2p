// Lógica pura de Blackjack. Sin DOM ni red.
//
// Modelo P2P sin secretos: no hay carta tapada (regla europea: la banca recibe su 2ª carta al final)
// y cada carta se sortea entre todos en el momento en que se necesita (ver fair.js). El motor pide
// cartas con draw(); si la carta todavía no fue sorteada lanza NEED_CARD, el host la sortea con todos
// y vuelve a ejecutar el paso desde una foto previa (snapshot/restore). Todo es determinístico.

import { randomHex, isHex, chainStep, makeChain, cardSeed, seededRandInt, sha256Hex } from './fair.js';
export { randomHex, chainStep, makeChain } from './fair.js';

export const RULES = Object.freeze({
  decks: 6, // mezcladora continua: el mazo de 6 barajas se rearma en cada mano
  minBet: 10,
  betStep: 10, // múltiplos de 10 => el pago 3:2 siempre es entero
  startChips: 1000,
  dealerHitsSoft17: false, // la banca se planta en todos los 17
  maxHands: 4, // hasta 3 divisiones por jugador
  maxPlayers: 7,
  chainLength: 320, // más que cualquier cantidad de cartas posible en una mano
});

export const TABLE_COLORS = ['green', 'red', 'blue', 'black', 'purple'];

// Tienda: consumibles que se compran con fichas (para uno o de regalo). Duran algunas manos.
export const SHOP = Object.freeze([
  { id: 'coffee', cat: 'Café', name: 'Café', icon: '☕', price: 20, rounds: 2 },
  { id: 'mate', cat: 'Café', name: 'Mate', icon: '🧉', price: 15, rounds: 3 },
  { id: 'soda', cat: 'Bebidas', name: 'Gaseosa', icon: '🥤', price: 15, rounds: 2 },
  { id: 'beer', cat: 'Bebidas', name: 'Cerveza', icon: '🍺', price: 40, rounds: 3 },
  { id: 'wine', cat: 'Bebidas', name: 'Vino tinto', icon: '🍷', price: 60, rounds: 3 },
  { id: 'martini', cat: 'Bebidas', name: 'Martini', icon: '🍸', price: 70, rounds: 3 },
  { id: 'whisky', cat: 'Bebidas', name: 'Whisky', icon: '🥃', price: 80, rounds: 4 },
  { id: 'champagne', cat: 'Bebidas', name: 'Champagne', icon: '🍾', price: 200, rounds: 5 },
  { id: 'cigarette', cat: 'Tabaco', name: 'Cigarrillo', icon: '🚬', price: 30, rounds: 2 },
  { id: 'cigar', cat: 'Tabaco', name: 'Puro', icon: 'cigar', price: 120, rounds: 5 },
  { id: 'fries', cat: 'Comida', name: 'Papas fritas', icon: '🍟', price: 25, rounds: 2 },
  { id: 'hotdog', cat: 'Comida', name: 'Pancho', icon: '🌭', price: 30, rounds: 2 },
  { id: 'empanadas', cat: 'Comida', name: 'Empanadas', icon: '🥟', price: 35, rounds: 3 },
  { id: 'pizza', cat: 'Comida', name: 'Pizza', icon: '🍕', price: 45, rounds: 3 },
  { id: 'burger', cat: 'Comida', name: 'Hamburguesa', icon: '🍔', price: 50, rounds: 3 },
  { id: 'sushi', cat: 'Comida', name: 'Sushi', icon: '🍣', price: 90, rounds: 4 },
  { id: 'cumaso', cat: 'Especiales', name: 'Cumaso', icon: '💦', price: 50, rounds: 1 },
]);
export const shopItem = (id) => SHOP.find((it) => it.id === id) || null;

export const HOST = '@host'; // aporte de aleatoriedad del host (la "casa")
export const NEED_CARD = Object.freeze({ needCard: true });

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function cardValue(rank) {
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c.r);
    if (c.r === 'A') aces++;
  }
  let soft = false;
  if (aces > 0 && total + 10 <= 21) {
    total += 10;
    soft = true;
  }
  return { total, soft };
}

// Blackjack natural: 2 cartas que suman 21 y NO provienen de una división.
export function isNatural(hand) {
  return !hand.fromSplit && hand.cards.length === 2 && handValue(hand.cards).total === 21;
}

export const isCard = (c) => !!c && RANKS.includes(c.r) && SUITS.includes(c.s);

function secureRandomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n; // rechazo para evitar sesgo de módulo
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % n;
}

// Elige una carta de lo que queda en el mazo (6 barajas menos lo ya repartido en la mano).
export function pickCard(decks, used, randInt) {
  const count = {};
  for (const c of used) count[c.r + c.s] = (count[c.r + c.s] || 0) + 1;
  const remaining = decks * 52 - used.length;
  if (remaining <= 0) throw new Error('No quedan cartas');
  let idx = randInt(remaining);
  for (const s of SUITS) {
    for (const r of RANKS) {
      const n = decks - (count[r + s] || 0);
      if (idx < n) return { r, s };
      idx -= n;
    }
  }
  throw new Error('Mazo inconsistente');
}

// Carta k de la mano a partir de lo revelado por los participantes activos (en orden).
export const cardFromValues = (rules, roundNo, k, values, used) =>
  pickCard(rules.decks, used, seededRandInt(cardSeed(roundNo, k, values)));

// Mazo mezclado completo (lo usan los tests).
export function newShoe(decks = RULES.decks, randInt = secureRandomInt) {
  const shoe = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

const hide = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: false, writable: true });
const emptyFair = () => ({ contributors: [], anchors: {}, reveals: [], dropped: [], nextAnchors: {} });

// p2p: true => las cartas se sortean entre todos (draw lanza NEED_CARD).
// Si no, las cartas salen de cardSource / shoeFactory (tests) o de un sorteo local seguro.
export function createGame({ rules = RULES, p2p = false, shoeFactory = null, cardSource = null } = {}) {
  const g = {
    rules,
    phase: 'betting', // betting -> dealing -> playing -> done -> betting
    hostId: null,
    players: {},
    seats: [],
    round: [],
    turn: null, // { pid, hand }
    dealer: { cards: [] },
    cards: [], // cartas sorteadas en esta mano, en orden (todas públicas)
    roundNo: 0,
    roundLog: null, // registro público para re-simular la mano
    message: 'Hagan sus apuestas',
    tableColor: 'green',
    shopLog: [], // compras desde el último reparto (público, para que los jugadores cuadren las fichas)
    shopSeq: 0,
    fair: emptyFair(),
  };
  let source = null;
  if (!p2p) {
    if (cardSource) source = cardSource;
    else if (shoeFactory) {
      let deck = [];
      source = () => {
        if (!deck.length) deck = shoeFactory();
        return deck.pop();
      };
    } else source = (gg) => pickCard(gg.rules.decks, gg.cards, secureRandomInt);
  }
  hide(g, '_source', source);
  hide(g, '_ptr', 0); // cartas ya consumidas por el motor
  // Nunca se publica: tokens de los jugadores y la cadena secreta del host.
  hide(g, '_secret', { tokens: new Map(), hostChain: null });
  return g;
}

function draw(g) {
  if (g._ptr < g.cards.length) return g.cards[g._ptr++];
  if (g._source) {
    const c = g._source(g);
    g.cards.push(c);
    g._ptr++;
    return c;
  }
  throw NEED_CARD;
}

// Foto del estado para reintentar un paso cuando falta una carta. Las cartas sorteadas no se pierden.
const SNAP_KEYS = ['phase', 'players', 'seats', 'round', 'turn', 'dealer', 'roundNo', 'roundLog', 'message'];
export function snapshot(g) {
  const s = {};
  for (const k of SNAP_KEYS) s[k] = g[k];
  return { data: JSON.parse(JSON.stringify(s)), ptr: g._ptr };
}
export function restore(g, snap) {
  const d = JSON.parse(JSON.stringify(snap.data));
  for (const k of SNAP_KEYS) g[k] = d[k];
  g._ptr = snap.ptr;
}

function newHand(cards, bet, fromSplit = false) {
  return { cards, bet, done: false, doubled: false, fromSplit, splitAces: false, result: null, payout: 0 };
}

// auto: plantado automático de un desconectado, que ocurre dentro de la jugada de otro.
function logAction(g, pid, a, auto = false) {
  if (g.roundLog) g.roundLog.actions.push(auto ? { pid, a, auto: true } : { pid, a });
}

// ---------- Jugadores ----------

const CTRL_RE = new RegExp(
  '[' +
    [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]]
      .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b))
      .join('') +
    ']',
  'g',
);

export function cleanName(raw) {
  return String(raw ?? '').replace(CTRL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// Alta o reconexión. Reconectar exige el token secreto que el jugador generó al entrar.
export function joinPlayer(g, rawName, token, newId) {
  const name = cleanName(rawName);
  if (!name) return { error: 'Nombre inválido' };
  if (!isHex(token, 32, 128)) return { error: 'Sesión inválida' };
  const sec = g._secret;
  const existing = Object.values(g.players).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (sec.tokens.get(existing.id) !== token) return { error: 'Ese nombre ya está en uso en la mesa' };
    existing.connected = true;
    return { id: existing.id, reconnected: true };
  }
  if (g.seats.length >= g.rules.maxPlayers) {
    // liberar un lugar de alguien desconectado que no esté jugando la mano actual
    const free = g.seats.find((s) => !g.players[s].connected && !g.round.includes(s));
    if (!free) return { error: 'La mesa está llena' };
    delete g.players[free];
    sec.tokens.delete(free);
    g.seats = g.seats.filter((s) => s !== free);
  }
  if (g.players[newId] || newId === HOST) return { error: 'Id duplicado' };
  g.players[newId] = { id: newId, name, chips: g.rules.startChips, bet: 0, sitOut: false, hands: [], connected: true, item: null, rebuys: 0 };
  sec.tokens.set(newId, token);
  g.seats.push(newId);
  return { id: newId };
}

// Atajo para tests: agrega un jugador nuevo y devuelve error o null.
export function addPlayer(g, id, name, token = randomHex(16)) {
  const r = joinPlayer(g, name, token, id);
  return r.error || null;
}

export function disconnectPlayer(g, id) {
  const p = g.players[id];
  if (!p) return;
  p.connected = false;
  if (g.phase === 'playing' && g.turn && g.turn.pid === id) {
    p.hands[g.turn.hand].done = true; // se planta automáticamente
    logAction(g, id, 'stand');
    advance(g);
  }
}

// ---------- Tienda ----------

export const shopOpen = (g) => g.phase === 'betting' || g.phase === 'done';

// Compra un consumible para `to` (uno mismo o regalo). Un consumible a la vez por jugador.
export function buyItem(g, buyerId, itemId, toId) {
  const buyer = g.players[buyerId];
  const to = g.players[toId];
  const item = shopItem(itemId);
  if (!buyer || !to) return 'Jugador desconocido';
  if (!item) return 'Ese producto no existe';
  if (!shopOpen(g)) return 'La tienda abre entre manos';
  if (to.item) return buyerId === toId ? 'Ya tenés algo: terminalo antes de comprar otro' : `${to.name} ya tiene algo (un consumible a la vez)`;
  const reserved = g.phase === 'betting' ? buyer.bet : 0; // lo apostado no se puede gastar
  if (buyer.chips - reserved < item.price) return 'No te alcanzan las fichas';
  buyer.chips -= item.price;
  to.item = { id: item.id, from: buyerId === toId ? null : buyerId, until: g.roundNo + item.rounds };
  g.shopSeq++;
  g.shopLog.push({ seq: g.shopSeq, buyer: buyerId, to: toId, item: item.id, price: item.price });
  if (g.shopLog.length > 60) g.shopLog.shift();
  return null;
}

// Terminar/tirar el consumible propio (para poder tener otro).
export function dropItem(g, id) {
  const p = g.players[id];
  if (!p) return 'Jugador desconocido';
  if (!p.item) return 'No tenés nada';
  p.item = null;
  return null;
}

// Color del paño (lo elige el host; es solo estético).
export function setTableColor(g, color) {
  if (!TABLE_COLORS.includes(color)) return 'Color inválido';
  g.tableColor = color;
  return null;
}

// Compromiso (ancla de la cadena) de un jugador para la próxima mano.
export function submitAnchor(g, id, roundNo, anchor) {
  if (!g.players[id]) return 'Jugador desconocido';
  if (g.phase !== 'betting' || roundNo !== g.roundNo + 1) return 'Fuera de tiempo';
  if (!isHex(anchor, 64, 64)) return 'Compromiso inválido';
  g.fair.nextAnchors[id] = anchor;
  return null;
}

const needsAnchor = (g, id) => !g._source && id !== g.hostId;

export function placeBet(g, id, amount) {
  const p = g.players[id];
  if (!p) return 'Jugador desconocido';
  if (g.phase !== 'betting') return 'No es momento de apostar';
  amount = typeof amount === 'number' ? amount : NaN;
  if (!Number.isInteger(amount) || amount < 0) return 'Apuesta inválida';
  if (amount === 0) {
    p.bet = 0;
    p.sitOut = true; // pasa esta mano
    return null;
  }
  if (amount < g.rules.minBet) return `La apuesta mínima es ${g.rules.minBet}`;
  if (amount % g.rules.betStep !== 0) return `La apuesta debe ser múltiplo de ${g.rules.betStep}`;
  if (amount > p.chips) return 'No tenés suficientes fichas';
  if (needsAnchor(g, id) && !g.fair.nextAnchors[id]) return 'Sincronizando con la mesa, probá de nuevo en un segundo';
  p.bet = amount;
  p.sitOut = false;
  return null;
}

// Pedir fichas cuando te quedaste sin: entre 500 y 1.000.000 (múltiplos de 10).
// El monto (y la frase del aviso) sale de lo que todos revelaron en la última mano, así el host no lo
// elige: cualquiera lo recalcula con rebuyDraw sobre el estado público.
export const REBUY = Object.freeze({ min: 500, max: 1000000, step: 10, lines: 40 }); // cantidad de frases del aviso (REBUY_LINES en app.js)

// Curva de probabilidad del pedido de fichas: 400 bandas de igual probabilidad (0,25% cada una).
// REBUY_CURVE[i] es el monto donde empieza la banda i. Las bandas son cada vez más anchas, así que cada
// monto es un poco menos probable que el anterior (sin saltos). Aproximadamente:
// 54% más de 10.000 · 22% más de 100.000 · 8,4% más de 300.000 · 2,5% más de 600.000 ·
// 0,46% más de 900.000 · 0,045% más de 990.000. Son enteros fijos (no se calculan con Math.exp/log)
// para que todos los navegadores obtengan exactamente el mismo monto al verificar.
export const REBUY_CURVE = Object.freeze([
  500, 510, 520, 530, 540, 550, 560, 570, 580, 590, 600, 610,
  620, 630, 640, 650, 660, 670, 680, 690, 700, 710, 720, 730,
  740, 750, 760, 770, 780, 790, 800, 810, 820, 830, 840, 850,
  860, 870, 880, 890, 900, 910, 930, 950, 970, 990, 1010, 1030,
  1050, 1070, 1090, 1110, 1130, 1150, 1170, 1190, 1210, 1230, 1250, 1270,
  1290, 1310, 1330, 1350, 1370, 1390, 1410, 1430, 1450, 1470, 1490, 1510,
  1540, 1570, 1600, 1630, 1660, 1690, 1720, 1750, 1780, 1810, 1840, 1870,
  1900, 1930, 1960, 1990, 2020, 2050, 2080, 2120, 2160, 2200, 2240, 2280,
  2320, 2360, 2400, 2440, 2480, 2520, 2560, 2600, 2640, 2680, 2730, 2780,
  2830, 2880, 2930, 2980, 3030, 3080, 3130, 3180, 3230, 3280, 3340, 3400,
  3460, 3520, 3580, 3640, 3700, 3760, 3820, 3890, 3960, 4030, 4100, 4170,
  4240, 4310, 4380, 4460, 4540, 4620, 4700, 4780, 4860, 4940, 5020, 5110,
  5200, 5290, 5380, 5470, 5560, 5660, 5760, 5860, 5960, 6060, 6160, 6270,
  6380, 6490, 6600, 6710, 6830, 6950, 7070, 7190, 7310, 7440, 7570, 7700,
  7830, 7960, 8100, 8240, 8380, 8520, 8670, 8820, 8970, 9120, 9280, 9440,
  9600, 9770, 9940, 10110, 10280, 10460, 10640, 10820, 11010, 11200, 11390, 11590,
  11790, 11990, 12200, 12410, 12620, 12840, 13060, 13290, 13520, 13750, 13990, 14230,
  14480, 14730, 14990, 15250, 15510, 15780, 16050, 16330, 16610, 16900, 17190, 17490,
  17790, 18100, 18410, 18730, 19050, 19380, 19720, 20060, 20410, 20760, 21120, 21490,
  21860, 22240, 22630, 23020, 23420, 23830, 24240, 24660, 25090, 25530, 25970, 26420,
  26880, 27350, 27820, 28300, 28790, 29290, 29800, 30320, 30850, 31390, 31940, 32490,
  33050, 33620, 34200, 34790, 35390, 36010, 36640, 37280, 37930, 38590, 39260, 39950,
  40650, 41370, 42100, 42850, 43610, 44390, 45180, 45990, 46820, 47660, 48520, 49400,
  50300, 51210, 52140, 53090, 54060, 55050, 56060, 57090, 58150, 59230, 60330, 61450,
  62600, 63770, 64960, 66180, 67420, 68690, 69980, 71300, 72650, 74030, 75430, 76860,
  78320, 79810, 81330, 82890, 84480, 86100, 87750, 89440, 91160, 92920, 94710, 96540,
  98410, 100320, 102270, 104260, 106290, 108360, 110470, 112630, 114830, 117080, 119370, 121710,
  124100, 126540, 129030, 131570, 134160, 136800, 139500, 142260, 145070, 147940, 150870, 153860,
  156910, 160020, 163200, 166440, 169750, 173130, 176580, 180100, 183690, 187380, 191180, 195100,
  199140, 203300, 207590, 212020, 216580, 221280, 226130, 231130, 236290, 241610, 247090, 252740,
  258560, 264570, 270760, 277140, 283720, 290500, 297500, 304710, 312150, 319820, 327720, 335870,
  344270, 352930, 361860, 371070, 380560, 390350, 400440, 410840, 421560, 432940, 445350, 458890,
  473660, 489770, 507340, 526510, 547420, 570230, 595110, 622250, 651860, 684160, 719390, 757820,
  799540, 844380, 892570, 944350, 1000000,
]);

export function rebuyDraw(state, pid, n) {
  const reveals = ((state.fair && state.fair.reveals) || []).flatMap((r) => Object.keys(r).sort().map((k) => r[k]));
  const ri = seededRandInt(sha256Hex(['bj-rebuy', state.roundNo, pid, n, ...reveals].join('|')));
  const bands = REBUY_CURVE.length - 1;
  const i = ri(bands);
  const last = i === bands - 1;
  const steps = (REBUY_CURVE[i + 1] - REBUY_CURVE[i]) / REBUY.step + (last ? 1 : 0); // el millón solo en la última banda
  const amount = REBUY_CURVE[i] + REBUY.step * ri(steps);
  return { amount, line: ri(REBUY.lines) };
}

export function rebuy(g, id) {
  const p = g.players[id];
  if (!p) return 'Jugador desconocido';
  if (g.phase !== 'betting') return 'Solo se pueden pedir fichas entre manos';
  if (p.chips >= g.rules.minBet) return 'Todavía tenés fichas';
  const n = p.rebuys || 0;
  const { amount, line } = rebuyDraw(g, id, n);
  p.chips += amount;
  p.rebuys = n + 1;
  g.shopSeq++;
  g.shopLog.push({ seq: g.shopSeq, kind: 'rebuy', pid: id, n, amount, line });
  if (g.shopLog.length > 60) g.shopLog.shift();
  return null;
}

// Para el reparto automático: ¿alguien apostó? ¿todos los conectados ya decidieron?
export function bettingStatus(g) {
  const connected = g.seats.map((id) => g.players[id]).filter((p) => p.connected);
  return {
    anyBet: connected.some((p) => p.bet > 0),
    allDecided: connected.length > 0 && connected.every((p) => p.bet > 0 || p.sitOut),
  };
}

// ---------- Sorteo de cartas entre todos ----------

// Participantes del sorteo que siguen activos para la carta k.
export function activeContributors(fair, k) {
  return fair.contributors.filter((c) => !fair.dropped.some((d) => d.cid === c && d.k <= k));
}

// Último valor publicado de la cadena de c antes de la carta k.
function lastValue(g, cid, k) {
  for (let i = k - 1; i >= 0; i--) if (g.fair.reveals[i] && g.fair.reveals[i][cid]) return g.fair.reveals[i][cid];
  return g.fair.anchors[cid];
}

// ¿Los valores que mandó c para las cartas k..k+n-1 encadenan bien con su compromiso?
export function checkReveals(g, cid, k, values) {
  if (!Array.isArray(values) || !values.length || !activeContributors(g.fair, k).includes(cid)) return false;
  if (k !== g.cards.length) return false;
  let prev = lastValue(g, cid, k);
  for (const v of values) {
    if (!isHex(v, 64, 64) || chainStep(v) !== prev) return false;
    prev = v;
  }
  return true;
}

export function hostReveals(g, k, n) {
  return g._secret.hostChain.slice(k + 1, k + 1 + n);
}

export function dropContributor(g, cid, k) {
  if (cid === HOST || g.fair.dropped.some((d) => d.cid === cid)) return;
  g.fair.dropped.push({ cid, k });
}

// Publica la carta k con los valores revelados ({ cid: valor }) por los participantes activos.
export function pushCard(g, values) {
  const k = g.cards.length;
  const active = activeContributors(g.fair, k);
  if (!active.every((c) => typeof values[c] === 'string')) throw new Error('Faltan revelaciones');
  const rev = {};
  for (const c of active) rev[c] = values[c];
  const card = cardFromValues(g.rules, g.roundNo, k, active.map((c) => rev[c]), g.cards);
  g.fair.reveals.push(rev);
  g.cards.push(card);
  return card;
}

// ---------- Ronda ----------

// Arranca la mano: cobra apuestas y fija quiénes participan del sorteo. No usa cartas.
export function beginRound(g) {
  if (g.phase !== 'betting') return 'No se puede repartir ahora';
  const participants = g.seats.filter((id) => {
    const p = g.players[id];
    return p.connected && p.bet > 0 && p.bet <= p.chips && (!needsAnchor(g, id) || g.fair.nextAnchors[id]);
  });
  if (participants.length === 0) return 'Nadie apostó';

  g.roundNo++;
  g.round = participants;
  g.shopLog = []; // las compras anteriores ya quedaron reflejadas en las fichas iniciales de la mano
  g.roundLog = {
    roundNo: g.roundNo,
    participants: participants.map((id) => ({ id, bet: g.players[id].bet, chips: g.players[id].chips })),
    actions: [],
  };
  for (const id of g.seats) g.players[id].hands = [];
  for (const id of participants) {
    const p = g.players[id];
    p.chips -= p.bet;
    p.hands = [newHand([], p.bet)];
  }
  g.dealer = { cards: [] };
  g.turn = null;
  g.cards = [];
  g._ptr = 0;
  if (g._source) {
    g.fair = emptyFair();
  } else {
    const chain = makeChain(g.rules.chainLength);
    g._secret.hostChain = chain;
    const others = participants.filter((id) => id !== g.hostId);
    const anchors = { [HOST]: chain[0] };
    for (const id of others) anchors[id] = g.fair.nextAnchors[id];
    g.fair = { contributors: [HOST, ...others], anchors, reveals: [], dropped: [], nextAnchors: {} };
  }
  g.phase = 'dealing';
  g.message = 'Repartiendo...';
  return null;
}

// Reparto inicial: una carta a cada jugador, una a la banca, segunda carta a cada jugador.
export const initialCards = (g) => 2 * g.round.length + 1;

export function dealInitial(g) {
  if (g.phase !== 'dealing') return 'No se puede repartir ahora';
  for (let k = 0; k < 2; k++) {
    for (const id of g.round) g.players[id].hands[0].cards.push(draw(g));
    if (k === 0) g.dealer.cards.push(draw(g));
  }
  g.phase = 'playing';
  for (const id of g.round) {
    const h = g.players[id].hands[0];
    if (isNatural(h)) h.done = true;
  }
  g.message = 'Ronda en juego';
  advance(g);
  return null;
}

// Atajo sincrónico (tests y modo local): cobra y reparte.
export function deal(g) {
  const err = beginRound(g);
  if (err) return err;
  return dealInitial(g);
}

// Busca la siguiente mano pendiente (en orden de asiento) y le da el turno.
function advance(g) {
  for (const pid of g.round) {
    const p = g.players[pid];
    for (let i = 0; i < p.hands.length; i++) {
      const h = p.hands[i];
      if (h.done) continue;
      if (h.cards.length === 1) {
        // segunda mano de un split: recibe su 2ª carta cuando le llega el turno
        h.cards.push(draw(g));
        if (handValue(h.cards).total === 21) {
          h.done = true;
          continue;
        }
      }
      if (!p.connected) {
        h.done = true;
        logAction(g, pid, 'stand', true);
        continue;
      }
      g.turn = { pid, hand: i };
      return;
    }
  }
  g.turn = null;
  dealerPlay(g);
}

export function legalActions(g, id) {
  if (g.phase !== 'playing' || !g.turn || g.turn.pid !== id) return [];
  const p = g.players[id];
  const h = p && p.hands[g.turn.hand];
  if (!h || h.done) return [];
  const actions = ['hit', 'stand'];
  if (h.cards.length === 2 && p.chips >= h.bet) {
    actions.push('double');
    if (cardValue(h.cards[0].r) === cardValue(h.cards[1].r) && p.hands.length < g.rules.maxHands) {
      actions.push('split');
    }
  }
  return actions;
}

export function act(g, id, action) {
  if (g.phase !== 'playing' || !g.turn) return 'No es momento de jugar';
  if (g.turn.pid !== id) return 'No es tu turno';
  if (!legalActions(g, id).includes(action)) return 'Acción no permitida';
  const p = g.players[id];
  const idx = g.turn.hand;
  const h = p.hands[idx];
  logAction(g, id, action);

  switch (action) {
    case 'hit':
      h.cards.push(draw(g));
      if (handValue(h.cards).total >= 21) h.done = true;
      break;
    case 'stand':
      h.done = true;
      break;
    case 'double':
      p.chips -= h.bet;
      h.bet *= 2;
      h.doubled = true;
      h.cards.push(draw(g));
      h.done = true;
      break;
    case 'split': {
      p.chips -= h.bet;
      const aces = h.cards[0].r === 'A';
      const second = h.cards.pop();
      h.fromSplit = true;
      const nh = newHand([second], h.bet, true);
      p.hands.splice(idx + 1, 0, nh);
      if (aces) {
        // Ases divididos: una sola carta cada uno, sin más acciones.
        h.splitAces = nh.splitAces = true;
        h.cards.push(draw(g));
        nh.cards.push(draw(g));
        h.done = nh.done = true;
      } else {
        h.cards.push(draw(g));
        if (handValue(h.cards).total === 21) h.done = true;
      }
      break;
    }
  }
  advance(g);
  return null;
}

// Planta al jugador del turno (se usa cuando se le acaba el tiempo).
export function forceStand(g) {
  if (g.phase !== 'playing' || !g.turn) return 'No hay turno activo';
  g.players[g.turn.pid].hands[g.turn.hand].done = true;
  logAction(g, g.turn.pid, 'stand');
  advance(g);
  return null;
}

// Regla europea: la banca recibe su 2ª carta recién ahora (siempre, porque un Blackjack de la banca
// cambia lo que se devuelve). Pide más solo si queda alguna mano viva que no sea Blackjack.
function dealerPlay(g) {
  const live = g.round.flatMap((pid) => g.players[pid].hands).filter((h) => handValue(h.cards).total <= 21);
  g.dealer.cards.push(draw(g));
  const dealerBJ = isNatural({ cards: g.dealer.cards });
  if (!dealerBJ && live.length > 0 && !live.every(isNatural)) {
    for (;;) {
      const v = handValue(g.dealer.cards);
      if (v.total < 17 || (v.total === 17 && v.soft && g.rules.dealerHitsSoft17)) g.dealer.cards.push(draw(g));
      else break;
    }
  }
  settle(g);
  const dv = handValue(g.dealer.cards).total;
  if (isNatural({ cards: g.dealer.cards })) g.message = 'La banca tiene Blackjack';
  else g.message = dv > 21 ? `La banca se pasó (${dv})` : `La banca tiene ${dv}`;
}

function settle(g) {
  const dv = handValue(g.dealer.cards).total;
  const dBJ = isNatural({ cards: g.dealer.cards });
  const dBust = dv > 21;
  for (const pid of g.round) {
    const p = g.players[pid];
    const original = g.roundLog.participants.find((q) => q.id === pid).bet;
    p.hands.forEach((h, i) => {
      const pv = handValue(h.cards).total;
      const pBJ = isNatural(h);
      let result;
      if (pv > 21) result = 'lose';
      else if (pBJ && dBJ) result = 'push';
      else if (pBJ) result = 'blackjack';
      else if (dBJ) result = 'lose';
      else if (dBust) result = 'win';
      else if (pv > dv) result = 'win';
      else if (pv < dv) result = 'lose';
      else result = 'push';
      h.result = result;
      h.payout = result === 'blackjack' ? h.bet * 2.5 : result === 'win' ? h.bet * 2 : result === 'push' ? h.bet : 0;
      // Contra Blackjack de la banca solo se pierde la apuesta original: se devuelve todo lo doblado o
      // dividido, aunque esas manos se hayan pasado (equivale a la regla con carta tapada).
      if (dBJ && !pBJ) h.payout = i === 0 ? h.bet - original : h.bet;
      h.done = true;
      p.chips += h.payout;
    });
  }
  g.turn = null;
  g.phase = 'done';
}

export function nextRound(g) {
  if (g.phase !== 'done') return 'La ronda no terminó';
  g.phase = 'betting';
  g.round = [];
  g.turn = null;
  g.dealer = { cards: [] };
  for (const id of g.seats) {
    const p = g.players[id];
    p.hands = [];
    p.bet = 0; // cada mano se confirma la apuesta (la UI recuerda el monto)
    p.sitOut = false;
    if (p.item && g.roundNo >= p.item.until) p.item = null; // se terminó el consumible
  }
  g.message = 'Hagan sus apuestas';
  return null;
}

// Estado que se manda a todos. No hay cartas ocultas: lo único privado son los tokens y la cadena del host.
export function publicState(g) {
  const s = {
    rules: g.rules,
    phase: g.phase,
    hostId: g.hostId,
    players: g.players,
    seats: g.seats,
    round: g.round,
    turn: g.turn,
    dealer: g.dealer,
    cards: g.cards,
    roundNo: g.roundNo,
    roundLog: g.roundLog,
    fair: g.fair,
    message: g.message,
    tableColor: g.tableColor,
    shopLog: g.shopLog,
    shopSeq: g.shopSeq,
  };
  return JSON.parse(JSON.stringify(s));
}

// ---------- Auditoría (la corre cada jugador) ----------
// Re-simula la mano terminada con las mismas cartas y acciones y la compara con lo que dice el host.
// Devuelve también qué acción consumió cada carta (-1 = reparto inicial), para verificar que el host
// no pidió cartas antes de tiempo. { ok: true, cardActs } · { ok: false, reason } · { ok: null }
export function auditRound(s) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    const L = s.roundLog;
    if (s.phase !== 'done') return { ok: null, reason: 'la mano no terminó' };
    if (!L || L.roundNo !== s.roundNo) return fail('el host no mandó el registro de la mano');
    const ids = L.participants.map((p) => p.id);
    if (new Set(ids).size !== ids.length) return fail('participantes duplicados');
    const seatOrder = s.seats.filter((id) => ids.includes(id));
    if (JSON.stringify(seatOrder) !== JSON.stringify(ids)) return fail('orden de reparto alterado');
    for (const p of L.participants) {
      if (!Number.isInteger(p.bet) || p.bet < s.rules.minBet || p.bet % s.rules.betStep || p.bet > p.chips) {
        return fail('apuesta inválida en el registro');
      }
    }
    if (!Array.isArray(s.cards) || !s.cards.every(isCard)) return fail('cartas inválidas');

    let i = 0;
    let current = -1;
    const cardActs = [];
    const g = createGame({
      rules: s.rules,
      cardSource: () => {
        if (i >= s.cards.length) throw new Error('faltan cartas');
        cardActs.push(current);
        return s.cards[i++];
      },
    });
    for (const p of L.participants) {
      g.players[p.id] = { id: p.id, name: p.id, chips: p.chips, bet: p.bet, sitOut: false, hands: [], connected: true };
      g.seats.push(p.id);
    }
    if (deal(g)) return fail('reparto inválido');
    for (let j = 0; j < L.actions.length; j++) {
      const a = L.actions[j];
      if (g.phase !== 'playing') return fail('hay acciones de más en el registro');
      if (!a.auto) current = j; // las cartas de un plantado automático cuentan para la jugada que lo disparó
      const err = act(g, a.pid, a.a);
      if (err) return fail(`acción inválida en el registro (${err})`);
    }
    if (g.phase !== 'done') return fail('la mano no termina como dice el host');
    if (i !== s.cards.length) return fail('se sortearon cartas que no se usaron');

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(g.dealer.cards, s.dealer.cards)) return fail('las cartas de la banca no coinciden');
    const pick = (h) => ({ cards: h.cards, bet: h.bet, result: h.result, payout: h.payout, doubled: h.doubled });
    for (const id of ids) {
      const real = s.players[id];
      const sim = g.players[id];
      const name = real ? real.name : id;
      if (!real) return fail(`falta un jugador (${name})`);
      if (!same(real.hands.map(pick), sim.hands.map(pick))) return fail(`las manos de ${name} no coinciden`);
      if (real.chips !== sim.chips) return fail(`las fichas de ${name} no coinciden (${real.chips} vs ${sim.chips})`);
    }
    return { ok: true, cardActs };
  } catch (e) {
    return fail('estado malformado');
  }
}
