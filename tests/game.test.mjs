import assert from 'node:assert/strict';
import * as G from '../game.js';

const C = (r) => ({ r, s: '♠' });
// Cartas en orden de robo; se rellena con 5s para que no se acabe.
const rig = (...ranks) => () => [...ranks, ...Array(200).fill('5')].map(C).reverse();
const v = (...r) => G.handValue(r.map(C));
let n = 0;
const t = (name, fn) => { fn(); n++; };

function setup(ranks, players = ['a'], bets = [100], rules = G.RULES) {
  const g = G.createGame({ rules, shoeFactory: rig(...ranks) });
  players.forEach((p, i) => { assert.equal(G.addPlayer(g, p, p), null); assert.equal(G.placeBet(g, p, bets[i]), null); });
  assert.equal(G.deal(g), null);
  return g;
}

t('handValue', () => {
  assert.deepEqual(v('A', 'K'), { total: 21, soft: true });
  assert.deepEqual(v('A', 'A'), { total: 12, soft: true });
  assert.deepEqual(v('A', 'A', '9'), { total: 21, soft: true });
  assert.deepEqual(v('A', '6', '10'), { total: 17, soft: false });
  assert.deepEqual(v('A', '5'), { total: 16, soft: true });
  assert.deepEqual(v('10', '6', 'A'), { total: 17, soft: false });
  assert.deepEqual(v('A', 'A', 'A', 'A', '7'), { total: 21, soft: true });
  assert.deepEqual(v('K', 'Q', '2'), { total: 22, soft: false });
});

// Orden de reparto 1 jugador: p1, banca(up), p2, banca(hole)
t('blackjack paga 3:2', () => {
  const g = setup(['A', '9', 'K', '7']);
  assert.equal(g.phase, 'done');
  assert.equal(g.players.a.hands[0].result, 'blackjack');
  assert.equal(g.players.a.chips, 1150);
  assert.equal(g.dealer.cards.length, 2, 'banca no pide si solo hay BJ');
});

t('banca BJ con As: pierde sin jugar', () => {
  const g = setup(['10', 'A', '9', 'K']);
  assert.equal(g.phase, 'done');
  assert.equal(g.players.a.chips, 900);
  assert.equal(g.dealer.hidden, false);
});

t('banca BJ con 10 arriba', () => {
  const g = setup(['10', 'K', '9', 'A']);
  assert.equal(g.phase, 'done');
  assert.equal(g.players.a.hands[0].result, 'lose');
});

t('BJ vs BJ empata', () => {
  const g = setup(['A', 'A', 'K', 'Q']);
  assert.equal(g.players.a.hands[0].result, 'push');
  assert.equal(g.players.a.chips, 1000);
});

t('banca 10 arriba sin BJ: se juega, carta oculta escondida', () => {
  const g = setup(['10', 'K', '6', '9']);
  assert.equal(g.phase, 'playing');
  const ps = G.publicState(g);
  assert.equal(ps.dealer.cards[1], null);
  assert.equal(ps.shoe, undefined);
  assert.deepEqual(G.legalActions(g, 'a'), ['hit', 'stand', 'double']);
  G.act(g, 'a', 'stand'); // 16 vs 19
  assert.equal(g.players.a.hands[0].result, 'lose');
  assert.equal(g.players.a.chips, 900);
});

t('jugador se pasa pierde aunque la banca se pase', () => {
  // a: 10,6 ; banca 6 + 10 ; a pide K (26) ; banca no pide porque todos se pasaron
  const g = setup(['10', '6', '6', '10', 'K']);
  G.act(g, 'a', 'hit');
  assert.equal(g.players.a.hands[0].result, 'lose');
  assert.equal(g.dealer.cards.length, 2);
  assert.equal(g.players.a.chips, 900);
});

t('banca se pasa, jugador plantado gana 1:1', () => {
  const g = setup(['10', '6', '7', '10', 'K']); // a 17, banca 16 -> pide K = 26
  G.act(g, 'a', 'stand');
  assert.equal(g.dealer.cards.length, 3);
  assert.equal(g.players.a.hands[0].result, 'win');
  assert.equal(g.players.a.chips, 1100);
});

t('banca se planta en soft 17 (S17)', () => {
  const g = setup(['10', 'A', '8', '6']); // a 18, banca A6 = soft 17
  G.act(g, 'a', 'stand');
  assert.equal(g.dealer.cards.length, 2);
  assert.equal(g.players.a.hands[0].result, 'win');
});

t('H17 si se configura', () => {
  const g = setup(['10', 'A', '8', '6', '2'], ['a'], [100], { ...G.RULES, dealerHitsSoft17: true });
  G.act(g, 'a', 'stand');
  assert.equal(g.dealer.cards.length, 3);
  assert.equal(G.handValue(g.dealer.cards).total, 19);
  assert.equal(g.players.a.hands[0].result, 'lose');
});

t('banca pide con 16 y se planta con 17 duro', () => {
  const g = setup(['10', '10', '8', '6', 'A']); // banca 16 + A = 17
  G.act(g, 'a', 'stand');
  assert.equal(G.handValue(g.dealer.cards).total, 17);
  assert.equal(g.players.a.hands[0].result, 'win');
});

t('empate devuelve apuesta', () => {
  const g = setup(['10', '10', '8', '8']);
  G.act(g, 'a', 'stand');
  assert.equal(g.players.a.hands[0].result, 'push');
  assert.equal(g.players.a.chips, 1000);
});

t('doblar: apuesta x2, una carta, termina', () => {
  const g = setup(['6', '10', '5', '7', '10']); // a 11 dobla -> 21; banca 17
  G.act(g, 'a', 'double');
  const h = g.players.a.hands[0];
  assert.equal(h.cards.length, 3);
  assert.equal(h.bet, 200);
  assert.equal(h.result, 'win');
  assert.equal(g.players.a.chips, 1200);
});

t('no se puede doblar sin fichas suficientes', () => {
  const g = G.createGame({ shoeFactory: rig('6', '10', '5', '7') });
  G.addPlayer(g, 'a', 'a');
  G.placeBet(g, 'a', 600);
  G.deal(g);
  assert.deepEqual(G.legalActions(g, 'a'), ['hit', 'stand']);
  assert.equal(G.act(g, 'a', 'double'), 'Acción no permitida');
});

t('doblar con 3 cartas no permitido', () => {
  const g = setup(['2', '10', '3', '7', '2']);
  G.act(g, 'a', 'hit');
  assert.deepEqual(G.legalActions(g, 'a'), ['hit', 'stand']);
});

t('split de 8s: segunda mano recibe carta en su turno', () => {
  // a: 8,8 ; banca 10 + 7(hole) ; split: mano1 recibe 3 -> 11 ; dobla -> 10 = 21 ; mano2 recibe 10 -> 18 planta
  const g = setup(['8', '10', '8', '7', '3', '10', '10']);
  assert.ok(G.legalActions(g, 'a').includes('split'));
  G.act(g, 'a', 'split');
  const p = g.players.a;
  assert.equal(p.hands.length, 2);
  assert.equal(p.chips, 800);
  assert.equal(p.hands[1].cards.length, 1);
  G.act(g, 'a', 'double');
  assert.deepEqual(g.turn, { pid: 'a', hand: 1 });
  assert.equal(p.hands[1].cards.length, 2);
  G.act(g, 'a', 'stand');
  assert.equal(g.phase, 'done');
  assert.equal(p.hands[0].result, 'win'); // 21 vs 17 (pago 1:1 sobre 200)
  assert.equal(p.hands[1].result, 'win'); // 18 vs 17
  assert.equal(p.chips, 700 + 400 + 200);
});

t('split ases: una carta cada uno, 21 paga 1:1 no 3:2', () => {
  const g = setup(['A', '10', 'A', '7', 'K', '9']);
  G.act(g, 'a', 'split');
  const p = g.players.a;
  assert.equal(g.phase, 'done');
  assert.equal(p.hands[0].cards.length, 2);
  assert.equal(p.hands[1].cards.length, 2);
  assert.equal(p.hands[0].result, 'win');
  assert.equal(p.hands[0].payout, 200);
  assert.equal(p.hands[1].result, 'win'); // 20 vs 17
  assert.equal(p.chips, 1200);
});

t('split K-Q permitido (mismo valor)', () => {
  const g = setup(['K', '9', 'Q', '9']);
  assert.ok(G.legalActions(g, 'a').includes('split'));
});

t('máximo 4 manos', () => {
  const g = setup(['8', '10', '8', '7', '8', '8', '8', '8']);
  G.act(g, 'a', 'split'); // h0: 8,8
  G.act(g, 'a', 'split'); // h0: 8,8 again
  G.act(g, 'a', 'split'); // 4 manos
  assert.equal(g.players.a.hands.length, 4);
  assert.ok(!G.legalActions(g, 'a').includes('split'));
});

t('21 tras split no-ases se planta solo', () => {
  const g = setup(['K', '10', 'K', '7', 'A', '9']);
  G.act(g, 'a', 'split');
  // mano 0: K,A = 21 -> done ; mano 1: K,9
  assert.deepEqual(g.turn, { pid: 'a', hand: 1 });
  assert.equal(g.players.a.hands[0].done, true);
});

t('turnos, validación y multi-jugador', () => {
  // orden: a1 b1 D1 a2 b2 D2
  const g = setup(['10', '9', '10', '7', '9', '8'], ['a', 'b'], [100, 50]);
  assert.equal(G.act(g, 'b', 'stand'), 'No es tu turno');
  assert.equal(G.act(g, 'a', 'split'), 'Acción no permitida');
  G.act(g, 'a', 'stand'); // 17
  assert.deepEqual(g.turn, { pid: 'b', hand: 0 });
  G.act(g, 'b', 'stand'); // 18 ; banca 18
  assert.equal(g.players.a.hands[0].result, 'lose');
  assert.equal(g.players.b.hands[0].result, 'push');
  assert.equal(G.placeBet(g, 'a', 10), 'No es momento de apostar');
  assert.equal(G.nextRound(g), null);
  assert.equal(g.players.a.bet, 0, 'apuesta se confirma cada mano');
  assert.deepEqual(G.bettingStatus(g), { anyBet: false, allDecided: false });
  G.placeBet(g, 'a', 50);
  assert.deepEqual(G.bettingStatus(g), { anyBet: true, allDecided: false });
  G.placeBet(g, 'b', 0);
  assert.deepEqual(G.bettingStatus(g), { anyBet: true, allDecided: true });
  G.disconnectPlayer(g, 'a');
  assert.deepEqual(G.bettingStatus(g), { anyBet: false, allDecided: true });
});

t('desconexión en turno: se planta y sigue', () => {
  const g = setup(['10', '9', '10', '7', '9', '8'], ['a', 'b'], [100, 50]);
  G.disconnectPlayer(g, 'a');
  assert.deepEqual(g.turn, { pid: 'b', hand: 0 });
  G.act(g, 'b', 'stand');
  assert.equal(g.phase, 'done');
  // reconexión con mismo nombre y otro id conserva fichas
  G.nextRound(g);
  assert.equal(G.addPlayer(g, 'a2', 'a'), null);
  assert.equal(g.players.a2.chips, 900);
  assert.equal(g.players.a, undefined);
  assert.equal(G.addPlayer(g, 'x', 'B'), 'Ese nombre ya está en uso. Si te estás reconectando, esperá unos segundos y probá de nuevo');
});

t('desconectado no entra al reparto', () => {
  const g = G.createGame({ shoeFactory: rig() });
  G.addPlayer(g, 'a', 'a'); G.addPlayer(g, 'b', 'b');
  G.placeBet(g, 'a', 10); G.placeBet(g, 'b', 10);
  G.disconnectPlayer(g, 'b');
  G.deal(g);
  assert.deepEqual(g.round, ['a']);
  assert.equal(g.players.b.chips, 1000);
});

t('validación apuestas y recarga', () => {
  const g = G.createGame();
  G.addPlayer(g, 'a', 'a');
  assert.equal(G.deal(g), 'Nadie apostó');
  assert.ok(G.placeBet(g, 'a', 5));
  assert.ok(G.placeBet(g, 'a', 15));
  assert.ok(G.placeBet(g, 'a', 1010));
  assert.ok(G.placeBet(g, 'a', 'abc'));
  assert.ok(G.placeBet(g, 'a', 10.5));
  assert.equal(G.placeBet(g, 'a', 1000), null);
  assert.ok(G.rebuy(g, 'a'));
  g.players.a.chips = 0;
  assert.equal(G.rebuy(g, 'a'), null);
  assert.equal(g.players.a.chips, 1000);
});

t('zapato: 312 cartas, 24 de cada valor, rebarajado', () => {
  const s = G.newShoe(6);
  assert.equal(s.length, 312);
  const cnt = {};
  for (const c of s) cnt[c.r + c.s] = (cnt[c.r + c.s] || 0) + 1;
  assert.equal(Object.keys(cnt).length, 52);
  assert.ok(Object.values(cnt).every((x) => x === 6));
});

// ---------- Simulación aleatoria con invariantes ----------
t('fuzz', () => {
  const g = G.createGame();
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
  ids.forEach((id) => G.addPlayer(g, id, id));
  let rnd = 12345;
  const r = (n) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd % n; };
  const stats = { rounds: 0, bj: 0, win: 0, lose: 0, push: 0 };
  for (let round = 0; round < 50000; round++) {
    for (const id of ids) {
      if (G.rebuy(g, id) === null) {}
      const p = g.players[id];
      if (r(10) === 0) { G.placeBet(g, id, 0); continue; }
      const max = Math.floor(p.chips / 10);
      G.placeBet(g, id, 10 * (1 + r(Math.max(1, Math.min(max, 20)))));
    }
    if (r(20) === 0) G.disconnectPlayer(g, ids[r(5)]);
    const before = Object.fromEntries(ids.map((id) => [id, g.players[id].chips]));
    const shoeBefore = g.shoe.length;
    if (G.deal(g)) { ids.forEach((id) => G.addPlayer(g, id, id)); continue; }
    const reshuffled = g.shoe.length > shoeBefore;
    let guard = 0;
    while (g.phase === 'playing') {
      assert.ok(guard++ < 200);
      const pid = g.turn.pid;
      const legal = G.legalActions(g, pid);
      assert.ok(legal.length >= 2);
      const h = g.players[pid].hands[g.turn.hand];
      assert.ok(G.handValue(h.cards).total < 21, 'nunca se juega una mano con 21 o más');
      assert.ok(h.cards.length >= 2);
      if (r(30) === 0) G.disconnectPlayer(g, pid);
      else assert.equal(G.act(g, pid, legal[r(legal.length)]), null);
      assert.ok(g.players[pid].chips >= 0);
    }
    assert.equal(g.phase, 'done');
    const d = G.handValue(g.dealer.cards);
    const anyLive = g.round.some((id) => g.players[id].hands.some((h) => G.handValue(h.cards).total <= 21 && !G.isNatural(h)));
    const dealerBJ = G.isNatural({ cards: g.dealer.cards });
    if (anyLive && !dealerBJ) assert.ok(d.total >= 17, 'banca termina en 17+');
    if (d.total > 17 || (d.total === 17)) {
      // la banca no pidió de más: sin la última carta tenía < 17
      if (g.dealer.cards.length > 2) assert.ok(G.handValue(g.dealer.cards.slice(0, -1)).total < 17);
    }
    // conservación de fichas
    for (const id of ids) {
      const p = g.players[id];
      const delta = p.chips - before[id];
      if (!g.round.includes(id)) { assert.equal(delta, 0); continue; }
      let expect = 0;
      for (const h of p.hands) {
        expect += h.payout - h.bet;
        stats[h.result === 'blackjack' ? 'bj' : h.result]++;
        const pv = G.handValue(h.cards).total;
        if (pv > 21) assert.equal(h.result, 'lose');
        if (h.result === 'blackjack') assert.ok(G.isNatural(h) && !dealerBJ);
        if (h.splitAces) assert.equal(h.cards.length, 2);
        if (h.doubled) assert.equal(h.cards.length, 2 + 0 + (h.fromSplit ? 1 : 1) - 0 + 0 === 3 ? 3 : 3);
      }
      assert.equal(delta, expect);
      assert.ok(p.hands.length <= 4);
    }
    // conservación de cartas
    if (!reshuffled) {
      const used = g.round.reduce((a, id) => a + g.players[id].hands.reduce((b, h) => b + h.cards.length, 0), 0) + g.dealer.cards.length;
      assert.equal(shoeBefore - g.shoe.length, used);
    }
    assert.equal(G.publicState(g).dealer.cards.includes(null), false);
    G.nextRound(g);
    ids.forEach((id) => { if (!g.players[id]) return; if (!g.players[id].connected) G.addPlayer(g, id, id); });
    stats.rounds++;
  }
  console.log('fuzz stats', stats);
});

// Estrategia "plantarse siempre en 12+" vs ventaja conocida (sanity de pagos): ~ -5% a -6% aprox.
t('sanity EV', () => {
  const g = G.createGame();
  G.addPlayer(g, 'a', 'a');
  let wagered = 0, net = 0;
  for (let i = 0; i < 200000; i++) {
    g.players.a.chips = 1e9;
    G.placeBet(g, 'a', 10);
    const before = g.players.a.chips;
    G.deal(g);
    while (g.phase === 'playing') {
      const h = g.players.a.hands[g.turn.hand];
      G.act(g, 'a', G.handValue(h.cards).total >= 12 ? 'stand' : 'hit');
    }
    wagered += 10; net += g.players.a.chips - before;
    G.nextRound(g);
  }
  console.log('EV stand12:', (net / wagered * 100).toFixed(2) + '%');
});

console.log(`OK ${n} tests`);
