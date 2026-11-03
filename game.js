// Lógica pura de Blackjack. Sin DOM ni red: la corre solo el host (autoritativo).
// Los clientes usan legalActions/handValue sobre el estado público para la UI.

export const RULES = Object.freeze({
  decks: 6,
  reshuffleWhenRemaining: 0.25, // se rebaraja antes de repartir si queda < 25% del zapato
  minBet: 10,
  betStep: 10, // múltiplos de 10 => el pago 3:2 siempre es entero
  startChips: 1000,
  dealerHitsSoft17: false, // la banca se planta en todos los 17
  maxHands: 4, // hasta 3 divisiones por jugador
  maxPlayers: 7,
});

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

export function newShoe(decks = RULES.decks, randInt = secureRandomInt) {
  const shoe = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

export function createGame({ rules = RULES, shoeFactory } = {}) {
  const g = {
    rules,
    phase: 'betting', // betting -> playing -> done -> betting
    players: {},
    seats: [],
    round: [],
    turn: null, // { pid, hand }
    dealer: { cards: [], hidden: false },
    shoe: [],
    shoeSize: 0,
    roundNo: 0,
    message: 'Hagan sus apuestas',
  };
  Object.defineProperty(g, '_newShoe', { value: shoeFactory || (() => newShoe(rules.decks)), enumerable: false });
  reshuffle(g);
  return g;
}

function reshuffle(g) {
  g.shoe = g._newShoe();
  g.shoeSize = g.shoe.length;
}

function draw(g) {
  if (g.shoe.length === 0) reshuffle(g); // salvaguarda: prácticamente imposible con 6 mazos
  return g.shoe.pop();
}

function newHand(cards, bet, fromSplit = false) {
  return { cards, bet, done: false, doubled: false, fromSplit, splitAces: false, result: null, payout: 0 };
}

// ---------- Jugadores ----------

export function addPlayer(g, id, rawName) {
  const name = String(rawName ?? '').trim().slice(0, 20);
  if (!name) return 'Nombre inválido';
  const existing = Object.values(g.players).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.connected) return 'Ese nombre ya está en uso. Si te estás reconectando, esperá unos segundos y probá de nuevo';
    // Reconexión: conserva fichas y lugar, cambia el id de conexión.
    const oldId = existing.id;
    if (oldId !== id) {
      delete g.players[oldId];
      existing.id = id;
      g.players[id] = existing;
      g.seats = g.seats.map((s) => (s === oldId ? id : s));
      g.round = g.round.map((s) => (s === oldId ? id : s));
      if (g.turn && g.turn.pid === oldId) g.turn.pid = id;
    }
    existing.connected = true;
    return null;
  }
  if (g.seats.length >= g.rules.maxPlayers) {
    // liberar un lugar de alguien desconectado que no esté jugando la mano actual
    const free = g.seats.find((s) => !g.players[s].connected && !g.round.includes(s));
    if (!free) return 'La mesa está llena';
    delete g.players[free];
    g.seats = g.seats.filter((s) => s !== free);
  }
  g.players[id] = { id, name, chips: g.rules.startChips, bet: 0, sitOut: false, hands: [], connected: true };
  g.seats.push(id);
  return null;
}

export function disconnectPlayer(g, id) {
  const p = g.players[id];
  if (!p) return;
  p.connected = false;
  if (g.phase === 'playing' && g.turn && g.turn.pid === id) {
    p.hands[g.turn.hand].done = true; // se planta automáticamente
    advance(g);
  }
}

export function placeBet(g, id, amount) {
  const p = g.players[id];
  if (!p) return 'Jugador desconocido';
  if (g.phase !== 'betting') return 'No es momento de apostar';
  amount = Number(amount);
  if (!Number.isInteger(amount) || amount < 0) return 'Apuesta inválida';
  if (amount === 0) {
    p.bet = 0;
    p.sitOut = true; // pasa esta mano
    return null;
  }
  if (amount < g.rules.minBet) return `La apuesta mínima es ${g.rules.minBet}`;
  if (amount % g.rules.betStep !== 0) return `La apuesta debe ser múltiplo de ${g.rules.betStep}`;
  if (amount > p.chips) return 'No tenés suficientes fichas';
  p.bet = amount;
  p.sitOut = false;
  return null;
}

export function rebuy(g, id) {
  const p = g.players[id];
  if (!p) return 'Jugador desconocido';
  if (g.phase !== 'betting') return 'Solo se puede recargar entre manos';
  if (p.chips >= g.rules.minBet) return 'Todavía tenés fichas';
  p.chips = g.rules.startChips;
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

// ---------- Ronda ----------

export function deal(g) {
  if (g.phase !== 'betting') return 'No se puede repartir ahora';
  const participants = g.seats.filter((id) => {
    const p = g.players[id];
    return p.connected && p.bet > 0 && p.bet <= p.chips;
  });
  if (participants.length === 0) return 'Nadie apostó';

  let msg = '';
  if (g.shoe.length < g.shoeSize * g.rules.reshuffleWhenRemaining) {
    reshuffle(g);
    msg = 'Se rebarajó el zapato. ';
  }

  g.roundNo++;
  g.round = participants;
  for (const id of g.seats) g.players[id].hands = [];
  for (const id of participants) {
    const p = g.players[id];
    p.chips -= p.bet;
    p.hands = [newHand([], p.bet)];
  }
  g.dealer = { cards: [], hidden: true };
  g.turn = null;

  // Orden de casino: una carta a cada jugador, una a la banca (visible), segunda vuelta, carta oculta.
  for (let k = 0; k < 2; k++) {
    for (const id of participants) g.players[id].hands[0].cards.push(draw(g));
    g.dealer.cards.push(draw(g));
  }
  g.phase = 'playing';

  for (const id of participants) {
    const h = g.players[id].hands[0];
    if (isNatural(h)) h.done = true;
  }

  // La banca espía si muestra As o figura/10.
  const upVal = cardValue(g.dealer.cards[0].r);
  if ((upVal === 1 || upVal === 10) && isNatural({ cards: g.dealer.cards })) {
    g.dealer.hidden = false;
    settle(g);
    g.message = msg + 'La banca tiene Blackjack.';
    return null;
  }
  g.message = msg + 'Ronda en juego';
  advance(g);
  return null;
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

// El host puede plantar a un jugador colgado.
export function forceStand(g) {
  if (g.phase !== 'playing' || !g.turn) return 'No hay turno activo';
  g.players[g.turn.pid].hands[g.turn.hand].done = true;
  advance(g);
  return null;
}

function dealerPlay(g) {
  g.dealer.hidden = false;
  // Si todas las manos se pasaron o son blackjack, la banca no necesita pedir.
  const needsToPlay = g.round.some((pid) =>
    g.players[pid].hands.some((h) => handValue(h.cards).total <= 21 && !isNatural(h)),
  );
  if (needsToPlay) {
    for (;;) {
      const v = handValue(g.dealer.cards);
      if (v.total < 17 || (v.total === 17 && v.soft && g.rules.dealerHitsSoft17)) g.dealer.cards.push(draw(g));
      else break;
    }
  }
  settle(g);
  const dv = handValue(g.dealer.cards).total;
  g.message = dv > 21 ? `La banca se pasó (${dv})` : `La banca tiene ${dv}`;
}

function settle(g) {
  const dv = handValue(g.dealer.cards).total;
  const dBJ = isNatural({ cards: g.dealer.cards });
  const dBust = dv > 21;
  for (const pid of g.round) {
    const p = g.players[pid];
    for (const h of p.hands) {
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
      h.done = true;
      p.chips += h.payout;
    }
  }
  g.turn = null;
  g.phase = 'done';
}

export function nextRound(g) {
  if (g.phase !== 'done') return 'La ronda no terminó';
  g.phase = 'betting';
  g.round = [];
  g.turn = null;
  g.dealer = { cards: [], hidden: false };
  for (const id of g.seats) {
    const p = g.players[id];
    p.hands = [];
    p.bet = 0; // cada mano se confirma la apuesta (la UI recuerda el monto)
    p.sitOut = false;
  }
  g.message = 'Hagan sus apuestas';
  return null;
}

// Estado que se manda a todos: sin zapato y sin la carta oculta de la banca.
export function publicState(g) {
  const s = {
    rules: g.rules,
    phase: g.phase,
    players: g.players,
    seats: g.seats,
    round: g.round,
    turn: g.turn,
    dealer: {
      hidden: g.dealer.hidden,
      cards: g.dealer.hidden ? g.dealer.cards.map((c, i) => (i === 1 ? null : c)) : g.dealer.cards,
    },
    shoeLeft: g.shoe.length,
    shoeSize: g.shoeSize,
    roundNo: g.roundNo,
    message: g.message,
  };
  return JSON.parse(JSON.stringify(s));
}
