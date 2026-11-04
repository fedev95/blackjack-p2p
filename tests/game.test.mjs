import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as G from '../game.js';
import * as F from '../fair.js';
import { Verifier } from '../verify.js';

const C = (r, s = '♠') => ({ r, s });
// Cartas en orden de robo; se rellena con 5s para que no se acaben.
const rig = (...ranks) => () => [...ranks, ...Array(200).fill('5')].map((r) => C(r)).reverse();
const v = (...r) => G.handValue(r.map((x) => C(x)));
let n = 0;
const t = (name, fn) => {
  try {
    fn();
  } catch (e) {
    console.error('FALLA:', name);
    throw e;
  }
  n++;
};

// Orden de reparto (regla europea): carta a cada jugador, 1 a la banca, 2ª a cada jugador.
// La 2ª carta de la banca sale al final, después de todas las jugadas.
function setup(ranks, players = ['a'], bets = [100], rules = G.RULES) {
  const g = G.createGame({ rules, shoeFactory: rig(...ranks) });
  players.forEach((p, i) => {
    assert.equal(G.addPlayer(g, p, p), null);
    assert.equal(G.placeBet(g, p, bets[i]), null);
  });
  assert.equal(G.deal(g), null);
  return g;
}

// ---------- Reglas ----------

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

t('blackjack paga 3:2; la banca saca solo su 2ª carta', () => {
  const g = setup(['A', '9', 'K', '7']);
  assert.equal(g.phase, 'done');
  assert.equal(g.players.a.hands[0].result, 'blackjack');
  assert.equal(g.players.a.chips, 1150);
  assert.equal(g.dealer.cards.length, 2);
});

t('BJ vs BJ empata', () => {
  const g = setup(['A', 'A', 'K', 'K']);
  assert.equal(g.players.a.hands[0].result, 'push');
  assert.equal(g.players.a.chips, 1000);
});

t('banca con 1 sola carta mientras se juega', () => {
  const g = setup(['10', 'A', '9']);
  assert.equal(g.phase, 'playing');
  assert.equal(g.dealer.cards.length, 1);
  assert.deepEqual(G.legalActions(g, 'a'), ['hit', 'stand', 'double']);
});

t('banca BJ al final: pierde la apuesta original', () => {
  const g = setup(['10', 'A', '9', 'K']);
  G.act(g, 'a', 'stand');
  assert.equal(g.players.a.hands[0].result, 'lose');
  assert.equal(g.players.a.chips, 900);
  assert.equal(g.message, 'La banca tiene Blackjack');
});

t('banca BJ: se devuelve lo doblado', () => {
  const g = setup(['6', 'A', '5', '9', 'K']); // 11 dobla -> 20; banca A K
  G.act(g, 'a', 'double');
  const h = g.players.a.hands[0];
  assert.equal(h.result, 'lose');
  assert.equal(h.payout, 100);
  assert.equal(g.players.a.chips, 900);
});

t('banca BJ: se devuelve lo dividido', () => {
  const g = setup(['8', 'A', '8', 'K', '9', 'K']);
  G.act(g, 'a', 'split');
  G.act(g, 'a', 'stand');
  G.act(g, 'a', 'stand');
  assert.equal(g.players.a.chips, 900);
});

t('banca BJ: se devuelve lo doblado aunque se haya pasado', () => {
  const g = setup(['10', 'A', '2', 'K', 'K']); // 12 dobla -> 22; banca A K
  G.act(g, 'a', 'double');
  assert.equal(g.dealer.cards.length, 2);
  assert.equal(g.players.a.chips, 900);
});

t('jugador se pasa pierde; la banca igual saca su 2ª carta', () => {
  const g = setup(['10', '6', '6', 'K']);
  G.act(g, 'a', 'hit');
  assert.equal(g.players.a.hands[0].result, 'lose');
  assert.equal(g.dealer.cards.length, 2);
  assert.equal(g.players.a.chips, 900);
});

t('banca se pasa, jugador plantado gana 1:1', () => {
  const g = setup(['10', '6', '7', '10', 'K']); // a 17; banca 6+10=16 -> K = 26
  G.act(g, 'a', 'stand');
  assert.equal(g.dealer.cards.length, 3);
  assert.equal(g.players.a.hands[0].result, 'win');
  assert.equal(g.players.a.chips, 1100);
});

t('banca se planta en soft 17 (S17)', () => {
  const g = setup(['10', 'A', '8', '6']);
  G.act(g, 'a', 'stand');
  assert.equal(g.dealer.cards.length, 2);
  assert.equal(g.players.a.hands[0].result, 'win');
});

t('H17 si se configura', () => {
  const g = setup(['10', 'A', '8', '6', '2'], ['a'], [100], { ...G.RULES, dealerHitsSoft17: true });
  G.act(g, 'a', 'stand');
  assert.equal(G.handValue(g.dealer.cards).total, 19);
  assert.equal(g.players.a.hands[0].result, 'lose');
});

t('banca pide con 16 y se planta con 17 duro', () => {
  const g = setup(['10', '10', '8', '6', 'A']);
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
  const g = setup(['6', '10', '5', '10', '7']);
  G.act(g, 'a', 'double');
  const h = g.players.a.hands[0];
  assert.equal(h.cards.length, 3);
  assert.equal(h.bet, 200);
  assert.equal(h.result, 'win');
  assert.equal(g.players.a.chips, 1200);
});

t('no se puede doblar sin fichas suficientes', () => {
  const g = G.createGame({ shoeFactory: rig('6', '10', '5') });
  G.addPlayer(g, 'a', 'a');
  G.placeBet(g, 'a', 600);
  G.deal(g);
  assert.deepEqual(G.legalActions(g, 'a'), ['hit', 'stand']);
  assert.equal(G.act(g, 'a', 'double'), 'Acción no permitida');
});

t('doblar con 3 cartas no permitido', () => {
  const g = setup(['2', '10', '3', '2']);
  G.act(g, 'a', 'hit');
  assert.deepEqual(G.legalActions(g, 'a'), ['hit', 'stand']);
});

t('split de 8s: segunda mano recibe carta en su turno', () => {
  const g = setup(['8', '10', '8', '3', '10', '10', '7']);
  assert.ok(G.legalActions(g, 'a').includes('split'));
  G.act(g, 'a', 'split');
  const p = g.players.a;
  assert.equal(p.hands.length, 2);
  assert.equal(p.chips, 800);
  assert.equal(p.hands[1].cards.length, 1);
  G.act(g, 'a', 'double'); // 11 -> 21
  assert.deepEqual(g.turn, { pid: 'a', hand: 1 });
  assert.equal(p.hands[1].cards.length, 2);
  G.act(g, 'a', 'stand'); // 18 ; banca 10+7
  assert.equal(g.phase, 'done');
  assert.equal(p.hands[0].result, 'win');
  assert.equal(p.hands[1].result, 'win');
  assert.equal(p.chips, 700 + 400 + 200);
});

t('split ases: una carta cada uno, 21 paga 1:1 no 3:2', () => {
  const g = setup(['A', '10', 'A', 'K', '9', '7']);
  G.act(g, 'a', 'split');
  const p = g.players.a;
  assert.equal(g.phase, 'done');
  assert.equal(p.hands[0].result, 'win');
  assert.equal(p.hands[0].payout, 200);
  assert.equal(p.hands[1].result, 'win');
  assert.equal(p.chips, 1200);
});

t('split K-Q permitido (mismo valor)', () => {
  const g = setup(['K', '9', 'Q']);
  assert.ok(G.legalActions(g, 'a').includes('split'));
});

t('máximo 4 manos', () => {
  const g = setup(['8', '10', '8', '8', '8', '8']);
  G.act(g, 'a', 'split');
  G.act(g, 'a', 'split');
  G.act(g, 'a', 'split');
  assert.equal(g.players.a.hands.length, 4);
  assert.ok(!G.legalActions(g, 'a').includes('split'));
});

t('21 tras split no-ases se planta solo', () => {
  const g = setup(['K', '10', 'K', 'A', '9']);
  G.act(g, 'a', 'split');
  assert.deepEqual(g.turn, { pid: 'a', hand: 1 });
  assert.equal(g.players.a.hands[0].done, true);
});

t('turnos, validación y multi-jugador', () => {
  // orden: a1 b1 D1 a2 b2 ... D2
  const g = setup(['10', '9', '10', '7', '9', '8'], ['a', 'b'], [100, 50]);
  assert.equal(G.act(g, 'b', 'stand'), 'No es tu turno');
  assert.equal(G.act(g, 'a', 'split'), 'Acción no permitida');
  G.act(g, 'a', 'stand'); // 17
  assert.deepEqual(g.turn, { pid: 'b', hand: 0 });
  G.act(g, 'b', 'stand'); // 18 ; banca 10+8
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
  assert.deepEqual(g.roundLog.actions, [{ pid: 'a', a: 'stand' }, { pid: 'b', a: 'stand' }]);
  assert.equal(G.auditRound(G.publicState(g)).ok, true);
});

t('desconectado se planta solo dentro de la jugada de otro', () => {
  const g = setup(['10', '9', '10', '7', '9', '8'], ['a', 'b'], [100, 50]);
  G.disconnectPlayer(g, 'b'); // no es su turno
  G.act(g, 'a', 'stand');
  assert.equal(g.phase, 'done');
  assert.deepEqual(g.roundLog.actions, [{ pid: 'a', a: 'stand' }, { pid: 'b', a: 'stand', auto: true }]);
  const audit = G.auditRound(G.publicState(g));
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.cardActs, [-1, -1, -1, -1, -1, 0]); // la carta de la banca la disparó la jugada 0
});

t('reconexión exige token; nadie roba el lugar', () => {
  const g = G.createGame({ shoeFactory: rig() });
  const tokA = 'a'.repeat(32);
  assert.deepEqual(G.joinPlayer(g, 'Ana', tokA, 'p1'), { id: 'p1' });
  g.players.p1.chips = 777;
  G.disconnectPlayer(g, 'p1');
  assert.equal(G.joinPlayer(g, 'ana', 'b'.repeat(32), 'p2').error, 'Ese nombre ya está en uso en la mesa');
  assert.equal(G.joinPlayer(g, 'Ana', 'nohex', 'p2').error, 'Sesión inválida');
  assert.deepEqual(G.joinPlayer(g, 'Ana', tokA, 'p3'), { id: 'p1', reconnected: true });
  assert.equal(g.players.p1.chips, 777);
  assert.equal(Object.keys(g.players).length, 1);
  assert.equal(G.joinPlayer(g, 'X', tokA, G.HOST).error, 'Id duplicado');
});

t('nombres saneados', () => {
  const u = (h) => String.fromCharCode(parseInt(h, 16));
  assert.equal(G.cleanName('  Ju' + u('200B') + 'an' + u('202E') + '  ' + u('0A') + ' Pérez  '), 'Juan Pérez');
  assert.equal(G.cleanName(u('0') + u('200B') + u('2028') + u('FEFF')), '');
  assert.equal(G.cleanName('x'.repeat(50)).length, 20);
  const g = G.createGame();
  assert.equal(G.addPlayer(g, 'a', u('200B')), 'Nombre inválido');
});

t('desconectado no entra al reparto', () => {
  const g = G.createGame({ shoeFactory: rig() });
  G.addPlayer(g, 'a', 'a');
  G.addPlayer(g, 'b', 'b');
  G.placeBet(g, 'a', 10);
  G.placeBet(g, 'b', 10);
  G.disconnectPlayer(g, 'b');
  G.deal(g);
  assert.deepEqual(g.round, ['a']);
  assert.equal(g.players.b.chips, 1000);
});

t('validación apuestas y recarga', () => {
  const g = G.createGame();
  G.addPlayer(g, 'a', 'a');
  assert.equal(G.deal(g), 'Nadie apostó');
  for (const bad of [5, 15, 1010, 'abc', 10.5, '100', { valueOf: () => 100 }]) assert.ok(G.placeBet(g, 'a', bad));
  assert.equal(G.placeBet(g, 'a', 1000), null);
  assert.ok(G.rebuy(g, 'a'));
  g.players.a.chips = 5;
  assert.equal(G.rebuy(g, 'a'), null);
  const e = g.shopLog.at(-1);
  assert.equal(e.kind, 'rebuy');
  assert.equal(g.players.a.chips, 5 + e.amount);
  assert.ok(e.amount >= 500 && e.amount <= 1000000 && e.amount % 10 === 0);
  assert.ok(e.line >= 0 && e.line < 40);
  assert.deepEqual(G.rebuyDraw(G.publicState(g), 'a', 0), { amount: e.amount, line: e.line });
  assert.equal(g.players.a.rebuys, 1);
});

t('pickCard respeta lo que queda en el mazo', () => {
  const full = G.newShoe(1);
  const used = full.filter((c) => !(c.r === 'Q' && c.s === '♥'));
  for (let i = 0; i < 5; i++) assert.deepEqual(G.pickCard(1, used, () => 0), { r: 'Q', s: '♥' });
  assert.throws(() => G.pickCard(1, full, () => 0));
});

// ---------- Fuzz ----------

t('fuzz: 50.000 manos aleatorias con invariantes', () => {
  const g = G.createGame();
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const tok = (id) => id.charCodeAt(1).toString(16).repeat(16);
  ids.forEach((id) => G.addPlayer(g, id, id, tok(id)));
  let rnd = 12345;
  const r = (k) => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd % k;
  };
  let played = 0;
  for (let round = 0; round < 50000; round++) {
    for (const id of ids) {
      G.rebuy(g, id);
      const p = g.players[id];
      if (r(10) === 0) {
        G.placeBet(g, id, 0);
        continue;
      }
      const max = Math.floor(p.chips / 10);
      G.placeBet(g, id, 10 * (1 + r(Math.max(1, Math.min(max, 20)))));
    }
    if (r(20) === 0) G.disconnectPlayer(g, ids[r(5)]);
    const before = Object.fromEntries(ids.map((id) => [id, g.players[id].chips]));
    if (G.deal(g)) {
      ids.forEach((id) => G.addPlayer(g, id, id, tok(id)));
      continue;
    }
    played++;
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
    const dealerBJ = G.isNatural({ cards: g.dealer.cards });
    assert.ok(g.dealer.cards.length >= 2, 'la banca siempre saca su 2ª carta');
    const live = g.round.flatMap((id) => g.players[id].hands).filter((h) => G.handValue(h.cards).total <= 21);
    if (!dealerBJ && live.some((h) => !G.isNatural(h))) assert.ok(d.total >= 17, 'banca termina en 17+');
    if (g.dealer.cards.length > 2) assert.ok(G.handValue(g.dealer.cards.slice(0, -1)).total < 17, 'la banca no pide de más');
    for (const id of ids) {
      const p = g.players[id];
      const delta = p.chips - before[id];
      if (!g.round.includes(id)) {
        assert.equal(delta, 0);
        continue;
      }
      let expect = 0;
      const original = g.roundLog.participants.find((q) => q.id === id).bet;
      for (const h of p.hands) {
        expect += h.payout - h.bet;
        if (h.result === 'blackjack') assert.ok(G.isNatural(h) && !dealerBJ);
        if (h.splitAces) assert.equal(h.cards.length, 2);
        if (h.doubled) assert.equal(h.cards.length, 3);
        if (G.handValue(h.cards).total > 21) assert.equal(h.result, 'lose');
      }
      if (dealerBJ && !p.hands.some(G.isNatural)) assert.equal(delta, -original, 'contra BJ solo se pierde la apuesta original');
      assert.equal(delta, expect);
      assert.ok(p.hands.length <= 4);
    }
    const onTable = g.round.flatMap((id) => g.players[id].hands.flatMap((h) => h.cards)).concat(g.dealer.cards);
    assert.equal(onTable.length, g.cards.length);
    const cnt = {};
    for (const c of g.cards) assert.ok((cnt[c.r + c.s] = (cnt[c.r + c.s] || 0) + 1) <= 6);
    const audit = G.auditRound(G.publicState(g));
    assert.equal(audit.ok, true, JSON.stringify(audit));
    G.nextRound(g);
    ids.forEach((id) => {
      if (!g.players[id].connected) assert.equal(G.addPlayer(g, id, id, tok(id)), null);
    });
  }
  assert.ok(played > 45000);
});

// ---------- Criptografía ----------

t('sha256 coincide con Node', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const b = randomBytes(len);
    assert.equal(F.bytesToHex(F.sha256(new Uint8Array(b))), createHash('sha256').update(b).digest('hex'));
  }
  assert.equal(F.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

t('cadena de hashes', () => {
  const c = F.makeChain(10);
  assert.equal(c.length, 11);
  for (let i = 1; i <= 10; i++) assert.equal(F.chainStep(c[i]), c[i - 1]);
  assert.notEqual(F.makeChain(10)[0], c[0]);
});

t('sorteo de cartas uniforme (chi²)', () => {
  const counts = new Array(52).fill(0);
  const key = (c) => G.RANKS.indexOf(c.r) * 4 + G.SUITS.indexOf(c.s);
  const N = 10400;
  for (let i = 0; i < N; i++) counts[key(G.cardFromValues(G.RULES, 1, 0, [F.randomHex(32), F.randomHex(32)], []))]++;
  const exp = N / 52;
  const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 95, 'chi² = ' + chi); // 51 g.l., p ≈ 0.0002
});

// ---------- Mesa P2P simulada (protocolo completo) ----------
// El host (h) y los clientes (c1, c2) intercambian mensajes en memoria. hostHack permite simular trampas.

function p2pTable({ rounds, seed = 7, tamperState, hostHack, between, allIn = false, clients = ['c1', 'c2'] }) {
  const g = G.createGame({ p2p: true });
  G.addPlayer(g, 'h', 'Host');
  g.hostId = 'h';
  clients.forEach((c) => G.addPlayer(g, c, c));
  const inbox = [];
  const vs = new Map(clients.map((c) => [c, new Verifier(c, (m) => inbox.push({ from: c, m }))]));
  let rnd = seed;
  const r = (k) => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd % k;
  };
  const deliver = () => {
    while (inbox.length) {
      const { from, m } = inbox.shift();
      if (m.t === 'anchor') G.submitAnchor(g, from, m.round, m.anchor);
    }
  };
  const broadcast = () => {
    const st = G.publicState(g);
    if (tamperState) tamperState(st, g);
    for (const vv of vs.values()) vv.onState(JSON.parse(JSON.stringify(st)));
    deliver();
  };
  const ask = (k, nn, act, pending) => {
    const got = { [G.HOST]: G.hostReveals(g, k, nn) };
    for (const c of G.activeContributors(g.fair, k)) {
      if (c === G.HOST) continue;
      const vals = vs.get(c).onRevealRequest({ round: g.roundNo, k, n: nn, act, pending });
      if (vals && G.checkReveals(g, c, k, vals)) got[c] = vals;
      else G.dropContributor(g, c, k);
    }
    return got;
  };
  const collect = (nn, act, pending) => {
    const k = g.cards.length;
    const got = ask(k, nn, act, pending);
    for (let i = 0; i < nn; i++) {
      const vals = {};
      for (const c of G.activeContributors(g.fair, g.cards.length)) vals[c] = got[c][i];
      G.pushCard(g, vals);
      broadcast();
    }
  };
  const step = (fn, act, pending) => {
    for (;;) {
      const snap = G.snapshot(g);
      try {
        return fn(g);
      } catch (e) {
        if (e !== G.NEED_CARD) throw e;
        G.restore(g, snap);
        const nn = g.phase === 'dealing' && g.cards.length === 0 ? G.initialCards(g) : 1;
        collect(nn, act, pending);
      }
    }
  };
  const ctx = { g, vs, step, collect, ask, broadcast, r };
  let played = 0;
  broadcast();
  for (let k = 0; k < rounds; k++) {
    if (between) {
      between(ctx, k);
      broadcast();
    }
    for (const id of g.seats) {
      G.rebuy(g, id);
      const max = Math.floor(g.players[id].chips / 10) * 10;
      G.placeBet(g, id, allIn && max >= 10 ? max : 10 * (1 + r(10)));
      broadcast();
    }
    if (G.beginRound(g)) continue;
    played++;
    broadcast();
    step(G.dealInitial, -1, null);
    broadcast();
    while (g.phase === 'playing') {
      const pid = g.turn.pid;
      const legal = G.legalActions(g, pid);
      const a = legal[r(legal.length)];
      if (hostHack && hostHack(ctx, pid, a)) {
        broadcast();
        continue;
      }
      if (vs.has(pid)) vs.get(pid).noteAction(a);
      const idx = g.roundLog.actions.length;
      if (r(25) === 0) step(G.forceStand, idx, { pid, a: 'stand' });
      else step((gg) => G.act(gg, pid, a), idx, { pid, a });
      broadcast();
    }
    G.nextRound(g);
    broadcast();
  }
  return { vs: [...vs.values()], played, g };
}

t('P2P honesto: todas las cartas y manos verifican, sin alertas', () => {
  const { vs, played, g } = p2pTable({ rounds: 120 });
  assert.ok(played > 100);
  for (const vv of vs) {
    assert.deepEqual(vv.alerts, []);
    assert.equal(vv.roundsOk, played);
    assert.ok(vv.cardsOk > played * 5);
  }
  assert.deepEqual(g.fair.dropped, []);
});

t('P2P: el host no sabe la próxima carta (depende de los jugadores)', () => {
  const g = G.createGame({ p2p: true });
  G.addPlayer(g, 'h', 'Host');
  g.hostId = 'h';
  G.addPlayer(g, 'c', 'c');
  const chainC = F.makeChain(G.RULES.chainLength);
  G.submitAnchor(g, 'c', 1, chainC[0]);
  G.placeBet(g, 'c', 10);
  G.beginRound(g);
  assert.throws(() => G.dealInitial(g), (e) => e === G.NEED_CARD);
  const hostV = G.hostReveals(g, 0, 1)[0];
  let distinct = 0;
  for (let i = 0; i < 50; i++) {
    const a = G.cardFromValues(G.RULES, 1, 0, [hostV, F.randomHex(32)], []);
    const b = G.cardFromValues(G.RULES, 1, 0, [hostV, F.randomHex(32)], []);
    if (a.r !== b.r || a.s !== b.s) distinct++;
  }
  assert.ok(distinct > 40);
  assert.equal(G.checkReveals(g, 'c', 0, [F.randomHex(32)]), false);
  assert.equal(G.checkReveals(g, 'c', 0, chainC.slice(1, 4)), true);
  assert.equal(G.checkReveals(g, 'c', 0, chainC.slice(2, 4)), false);
});

const alerted = (vs, re) => vs.some((vv) => vv.alerts.some((a) => re.test(a)));

t('trampa: host cambia una carta publicada', () => {
  const { vs } = p2pTable({
    rounds: 6,
    tamperState: (st) => {
      if (st.roundNo === 3 && st.cards.length > 2) st.cards[1] = st.cards[1].r === 'A' ? C('K', '♥') : C('A', '♠');
    },
  });
  assert.ok(alerted(vs, /carta/), vs[0].alerts.join(' | '));
});

t('trampa: host altera una revelación', () => {
  const { vs } = p2pTable({
    rounds: 4,
    tamperState: (st) => {
      if (st.roundNo === 2 && st.fair.reveals[0]) st.fair.reveals[0][G.HOST] = '0'.repeat(64);
    },
  });
  assert.ok(alerted(vs, /Revelación inválida|cambió una carta/), vs[0].alerts.join(' | '));
});

t('trampa: host pide una carta antes de anunciar la jugada (espiar)', () => {
  let done = false;
  const { vs } = p2pTable({
    rounds: 6,
    hostHack: (ctx, pid) => {
      if (done || pid !== 'h') return false;
      done = true;
      ctx.ask(ctx.g.cards.length, 1, -1, null); // intenta ver la próxima carta sin comprometerse
      return false;
    },
  });
  assert.ok(done);
  assert.ok(alerted(vs, /excluyó/), vs[0].alerts.join(' | '));
});

t('trampa: host anuncia "pedir" y aplica "plantarse"', () => {
  let done = false;
  const { vs } = p2pTable({
    rounds: 8,
    hostHack: (ctx, pid) => {
      const { g } = ctx;
      if (done || pid !== 'h' || !G.legalActions(g, 'h').includes('hit')) return false;
      done = true;
      const idx = g.roundLog.actions.length;
      ctx.collect(1, idx, { pid: 'h', a: 'hit' }); // ve la carta...
      ctx.step((gg) => G.act(gg, 'h', 'stand'), idx, { pid: 'h', a: 'stand' }); // ...y decide otra cosa
      return true;
    },
  });
  assert.ok(done);
  assert.ok(alerted(vs, /antes de tiempo|anunció una jugada|sorteadon? cartas que no se usaron/), vs[0].alerts.join(' | '));
});

t('trampa: host juega por un cliente', () => {
  let done = false;
  const { vs } = p2pTable({
    rounds: 8,
    hostHack: (ctx, pid) => {
      const { g } = ctx;
      if (done || pid !== 'c1' || !G.legalActions(g, 'c1').includes('hit')) return false;
      done = true;
      const idx = g.roundLog.actions.length;
      ctx.step((gg) => G.act(gg, 'c1', 'hit'), idx, { pid: 'c1', a: 'hit' }); // c1 nunca pidió
      return true;
    },
  });
  assert.ok(done);
  assert.ok(vs[0].alerts.some((a) => /excluyó|jugó por vos/.test(a)), vs[0].alerts.join(' | '));
});

t('trampa: host excluye a un jugador del sorteo para controlar las cartas', () => {
  let done = false;
  const { vs } = p2pTable({
    rounds: 5,
    hostHack: (ctx) => {
      if (done) return false;
      done = true;
      G.dropContributor(ctx.g, 'c1', ctx.g.cards.length);
      return false;
    },
  });
  assert.ok(vs[0].alerts.some((a) => /excluyó/.test(a)), vs[0].alerts.join(' | '));
});

t('trampa: host se suma fichas', () => {
  let done = false;
  const { vs } = p2pTable({
    rounds: 6,
    tamperState: (st, g) => {
      if (!done && g.phase === 'betting' && g.roundNo === 3) {
        g.players.h.chips += 5000;
        done = true;
      }
    },
  });
  assert.ok(alerted(vs, /fichas de Host/), vs[0].alerts.join(' | '));
});

t('trampa: host cambia la apuesta de un jugador', () => {
  const { vs } = p2pTable({
    rounds: 4,
    tamperState: (st) => {
      if (st.roundLog && st.roundLog.roundNo === 2) {
        const p = st.roundLog.participants.find((q) => q.id === 'c1');
        if (p) p.bet = p.bet === 10 ? 20 : 10;
      }
    },
  });
  assert.ok(vs[0].alerts.some((a) => /apuesta|Mano 2/.test(a)), vs[0].alerts.join(' | '));
});

t('estado público no filtra secretos', () => {
  const g = G.createGame({ p2p: true });
  G.addPlayer(g, 'h', 'Host', 'f'.repeat(32));
  g.hostId = 'h';
  G.placeBet(g, 'h', 10);
  G.beginRound(g);
  const json = JSON.stringify(G.publicState(g));
  assert.ok(!json.includes('f'.repeat(32)), 'token');
  for (const x of g._secret.hostChain.slice(1)) assert.ok(!json.includes(x), 'cadena del host');
});

t('color del paño', () => {
  const g = G.createGame();
  assert.equal(G.publicState(g).tableColor, 'green');
  for (const c of G.TABLE_COLORS) assert.equal(G.setTableColor(g, c), null);
  assert.equal(G.publicState(g).tableColor, 'purple');
  for (const bad of ['pink', '"><img>', null, 1]) assert.equal(G.setTableColor(g, bad), 'Color inválido');
  assert.equal(g.tableColor, 'purple');
});

// ---------- Tienda ----------

t('tienda: comprar, regalar, uno a la vez, vencimiento', () => {
  const g = G.createGame({ shoeFactory: rig('10', '10', '9', '7', '8', '9') });
  G.addPlayer(g, 'a', 'Ana');
  G.addPlayer(g, 'b', 'Beto');
  assert.equal(G.buyItem(g, 'a', 'nada', 'a'), 'Ese producto no existe');
  assert.equal(G.buyItem(g, 'a', 'beer', 'zz'), 'Jugador desconocido');
  assert.equal(G.buyItem(g, 'a', 'beer', 'a'), null);
  assert.equal(g.players.a.chips, 960);
  assert.deepEqual(g.players.a.item, { id: 'beer', from: null, until: 3 });
  assert.equal(G.buyItem(g, 'a', 'coffee', 'a'), 'Ya tenés algo: terminalo antes de comprar otro');
  assert.equal(G.buyItem(g, 'b', 'coffee', 'a'), 'Ana ya tiene algo (un consumible a la vez)');
  assert.equal(G.buyItem(g, 'a', 'cigar', 'b'), null); // regalo
  assert.deepEqual(g.players.b.item, { id: 'cigar', from: 'a', until: 5 });
  assert.equal(g.players.a.chips, 840);
  assert.equal(g.players.b.chips, 1000);
  assert.equal(g.shopLog.length, 2);
  assert.equal(G.dropItem(g, 'a'), null);
  assert.equal(g.players.a.item, null);
  // lo apostado no se puede gastar
  G.placeBet(g, 'b', 970); // le quedan 30 libres; la cerveza sale 40
  assert.equal(G.buyItem(g, 'b', 'beer', 'a'), 'No te alcanzan las fichas');
  G.placeBet(g, 'b', 950);
  assert.equal(G.buyItem(g, 'b', 'beer', 'a'), null);
  G.placeBet(g, 'a', 10);
  // cerrada durante la mano
  G.deal(g);
  assert.equal(g.phase, 'playing');
  assert.equal(G.buyItem(g, 'a', 'coffee', 'a'), 'La tienda abre entre manos');
  assert.equal(G.buyItem(g, 'b', 'coffee', 'b'), 'La tienda abre entre manos');
  assert.deepEqual(g.shopLog, [], 'el registro se reinicia al repartir');
  while (g.phase === 'playing') G.act(g, g.turn.pid, 'stand');
  assert.equal(G.auditRound(G.publicState(g)).ok, true);
  assert.equal(G.buyItem(g, 'b', 'coffee', 'b'), 'Ya tenés algo: terminalo antes de comprar otro'); // abre en el resultado
  // vencimiento: la cerveza de Ana dura 3 manos (until = 0 + 3)
  G.nextRound(g);
  assert.ok(g.players.a.item);
  g.roundNo = 3;
  g.phase = 'done';
  G.nextRound(g);
  assert.equal(g.players.a.item, null, 'la cerveza venció');
  assert.ok(g.players.b.item, 'el puro (5 manos) sigue');
});

t('tienda: vencimiento exacto', () => {
  const g = G.createGame();
  G.addPlayer(g, 'a', 'a');
  G.buyItem(g, 'a', 'cigar', 'a'); // dura 5 manos
  for (let r = 1; r <= 5; r++) {
    G.placeBet(g, 'a', 10);
    G.deal(g);
    while (g.phase === 'playing') G.act(g, 'a', 'stand');
    G.nextRound(g);
    if (r < 5) assert.ok(g.players.a.item, 'sigue en la mano ' + r);
  }
  assert.equal(g.players.a.item, null);
});

t('P2P con compras honestas: sin alertas', () => {
  const items = G.SHOP.map((it) => it.id);
  const { vs, played } = p2pTable({
    rounds: 60,
    between: (ctx, k) => {
      const { g, vs: vmap, r } = ctx;
      for (const buyer of g.seats) {
        if (r(3)) continue;
        const to = g.seats[r(g.seats.length)];
        const item = items[r(items.length)];
        if (r(4) === 0) G.dropItem(g, to === buyer ? buyer : buyer);
        if (vmap.has(buyer)) vmap.get(buyer).noteBuy(item, to);
        G.buyItem(g, buyer, item, to);
      }
    },
  });
  for (const vv of vs) {
    assert.deepEqual(vv.alerts, []);
    assert.equal(vv.roundsOk, played);
  }
});

t('trampa: host compra con fichas de un cliente', () => {
  const { vs } = p2pTable({
    rounds: 4,
    between: (ctx, k) => {
      if (k === 2) G.buyItem(ctx.g, 'c1', 'champagne', 'h'); // c1 nunca lo pidió
    },
  });
  assert.ok(vs[0].alerts.some((a) => /con tus fichas/.test(a)), vs[0].alerts.join(' | '));
});

t('trampa: host cobra un precio falso / se descuenta fichas de más', () => {
  const { vs } = p2pTable({
    rounds: 4,
    between: (ctx, k) => {
      if (k === 2) {
        ctx.vs.get('c1').noteBuy('coffee', 'c1');
        G.buyItem(ctx.g, 'c1', 'coffee', 'c1');
        ctx.g.players.c1.chips -= 100; // cobra 120 por un café de 20
      }
    },
  });
  assert.ok(vs[0].alerts.some((a) => /fichas de c1/.test(a)), vs[0].alerts.join(' | '));
});

t('tienda: cumaso para uno mismo o de regalo', () => {
  const g = G.createGame();
  G.addPlayer(g, 'a', 'Ana');
  G.addPlayer(g, 'b', 'Beto');
  assert.equal(G.buyItem(g, 'a', 'cumaso', 'a'), null);
  assert.deepEqual(g.players.a.item, { id: 'cumaso', from: null, until: 1 });
  assert.equal(G.buyItem(g, 'a', 'cumaso', 'b'), null);
  assert.deepEqual(g.players.b.item, { id: 'cumaso', from: 'a', until: 1 });
  assert.equal(g.players.a.chips, 900);
  assert.equal(G.buyItem(g, 'a', 'cumaso', 'b'), 'Beto ya tiene algo (un consumible a la vez)');
});

t('pedir fichas: curva continua y decreciente', () => {
  const C = G.REBUY_CURVE;
  assert.equal(C[0], 500);
  assert.equal(C.at(-1), 1000000);
  for (let i = 1; i < C.length; i++) {
    assert.equal((C[i] - C[i - 1]) % 10, 0);
    assert.ok(C[i] > C[i - 1]);
    if (i > 1) assert.ok(C[i] - C[i - 1] >= C[i - 1] - C[i - 2], 'bandas cada vez más anchas (densidad decreciente)');
  }
  const N = 60000;
  const above = { 10000: 0, 100000: 0, 300000: 0, 600000: 0, 900000: 0 };
  const exp = { 10000: 0.544, 100000: 0.218, 300000: 0.084, 600000: 0.0246, 900000: 0.0046 };
  let min = Infinity, max = 0, sum = 0;
  const lines = new Set();
  for (let i = 0; i < N; i++) {
    const d = G.rebuyDraw({ roundNo: i, fair: { reveals: [{ x: F.randomHex(32) }] } }, 'p', 0);
    min = Math.min(min, d.amount); max = Math.max(max, d.amount); sum += d.amount;
    assert.equal(d.amount % 10, 0);
    lines.add(d.line);
    for (const k in above) if (d.amount > Number(k)) above[k]++;
  }
  assert.ok(min >= 500 && max <= 1000000);
  for (const k in above) {
    const got = above[k] / N;
    assert.ok(Math.abs(got - exp[k]) < Math.max(0.006, exp[k] * 0.3), `más de ${k}: ${got} vs ${exp[k]}`);
  }
  const mean = sum / N;
  assert.ok(mean > 70000 && mean < 95000, 'promedio ' + mean);
  assert.equal(lines.size, 40);
  console.log('  pedir fichas: promedio', Math.round(mean), Object.entries(above).map(([k, v]) => `>${k}: ${((100 * v) / N).toFixed(2)}%`).join(' '));
});

t('P2P: todos pierden todo y piden fichas: sin alertas', () => {
  const { vs, g } = p2pTable({ rounds: 40, allIn: true });
  for (const vv of vs) assert.deepEqual(vv.alerts, []);
  assert.ok(Object.values(g.players).some((p) => p.rebuys > 0), 'hubo pedidos de fichas');
});

t('trampa: host se inventa el monto de fichas pedidas', () => {
  const { vs } = p2pTable({
    rounds: 40,
    allIn: true,
    tamperState: (st) => {
      for (const e of st.shopLog) if (e.kind === 'rebuy' && e.pid === 'h') e.amount = 1000000;
    },
  });
  assert.ok(vs[0].alerts.some((a) => /inventó el monto|fichas de Host/.test(a)), vs[0].alerts.join(' | '));
});

// ---------- Cambio de host ----------

// Juega manos completas sobre una partida P2P ya armada, con verificadores para los no-host.
function playRounds(g, vs, rounds, r, { stopAt } = {}) {
  const deliver = (from, m) => {
    if (m.t === 'anchor') G.submitAnchor(g, from, m.round, m.anchor);
  };
  for (const [id, v] of vs) v.send = (m) => deliver(id, m);
  const broadcast = () => {
    const st = G.publicState(g);
    for (const v of vs.values()) v.onState(JSON.parse(JSON.stringify(st)));
  };
  const step = (fn, act, pending) => {
    for (;;) {
      const snap = G.snapshot(g);
      try {
        return fn(g);
      } catch (e) {
        if (e !== G.NEED_CARD) throw e;
        G.restore(g, snap);
        const nn = g.phase === 'dealing' && g.cards.length === 0 ? G.initialCards(g) : 1;
        const k = g.cards.length;
        const got = { [G.HOST]: G.hostReveals(g, k, nn) };
        for (const c of G.activeContributors(g.fair, k)) {
          if (c === G.HOST) continue;
          const vals = vs.get(c).onRevealRequest({ round: g.roundNo, k, n: nn, act, pending });
          if (vals && G.checkReveals(g, c, k, vals)) got[c] = vals;
          else G.dropContributor(g, c, k);
        }
        for (let i = 0; i < nn; i++) {
          const vals = {};
          for (const c of G.activeContributors(g.fair, g.cards.length)) vals[c] = got[c][i];
          G.pushCard(g, vals);
          broadcast();
        }
      }
    }
  };
  broadcast();
  for (let k = 0; k < rounds; k++) {
    for (const id of g.seats) {
      if (!g.players[id].connected) continue;
      G.rebuy(g, id);
      G.placeBet(g, id, 10 * (1 + r(10)));
      broadcast();
    }
    if (G.beginRound(g)) continue;
    broadcast();
    step(G.dealInitial, -1, null);
    broadcast();
    if (stopAt === 'playing' && g.phase === 'playing') return;
    while (g.phase === 'playing') {
      const pid = g.turn.pid;
      const legal = G.legalActions(g, pid);
      const a = legal[r(legal.length)];
      if (vs.has(pid)) vs.get(pid).noteAction(a);
      step((gg) => G.act(gg, pid, a), g.roundLog.actions.length, { pid, a });
      broadcast();
    }
    G.nextRound(g);
    broadcast();
  }
}

function hostChangeTable() {
  let rnd = 99;
  const r = (k) => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd % k;
  };
  const tok = { h: 'a'.repeat(32), c1: 'b'.repeat(32), c2: 'c'.repeat(32) };
  const g = G.createGame({ p2p: true });
  G.joinPlayer(g, 'Host', tok.h, 'h');
  g.hostId = 'h';
  G.joinPlayer(g, 'Uno', tok.c1, 'c1');
  G.joinPlayer(g, 'Dos', tok.c2, 'c2');
  const vs = new Map(['c1', 'c2'].map((c) => [c, new Verifier(c, () => {})]));
  return { g, vs, tok, r };
}

t('cambio de host: tokens validados por hash', () => {
  const { g, tok } = hostChangeTable();
  const json = JSON.stringify(G.publicState(g));
  for (const tk of Object.values(tok)) assert.ok(!json.includes(tk), 'el token no se publica');
  assert.equal(g.players.c2.tokenHash, G.tokenHash(tok.c2));
  const { game: g2 } = G.fromState(G.publicState(g), 'c1');
  assert.equal(g2.players.c2.connected, false);
  assert.equal(G.joinPlayer(g2, 'Dos', 'f'.repeat(32), 'x').error, 'Ese nombre ya está en uso en la mesa');
  assert.deepEqual(G.joinPlayer(g2, 'dos', tok.c2, 'x'), { id: 'c2', reconnected: true });
  assert.deepEqual(G.joinPlayer(g2, 'Host', tok.h, 'y'), { id: 'h', reconnected: true });
});

t('cambio de host a mitad de mano: se anula, se devuelven apuestas, sigue sin alertas', () => {
  const { g, vs, tok, r } = hostChangeTable();
  playRounds(g, vs, 6, r);
  playRounds(g, vs, 1, r, { stopAt: 'playing' });
  assert.equal(g.phase, 'playing');
  const before = Object.fromEntries(g.roundLog.participants.map((p) => [p.id, p.chips]));
  const items = JSON.stringify(Object.values(g.players).map((p) => p.item));
  const st = G.publicState(g);

  // c1 se convierte en host: el viejo host y c2 se reconectan como jugadores
  const { game: g2, voided } = G.fromState(st, 'c1');
  assert.equal(voided, true);
  assert.equal(g2.phase, 'betting');
  assert.equal(g2.roundNo, g.roundNo);
  for (const id in before) assert.equal(g2.players[id].chips, before[id], 'apuesta devuelta a ' + id);
  assert.equal(JSON.stringify(Object.values(g2.players).map((p) => p.item)), items);
  assert.equal(G.joinPlayer(g2, 'Host', tok.h, 'nuevo').id, 'h');
  assert.equal(G.joinPlayer(g2, 'Dos', tok.c2, 'nuevo').id, 'c2');

  // ahora verifican 'h' (ex host) y 'c2'; c1 es la autoridad
  const vs2 = new Map([['c2', vs.get('c2')], ['h', new Verifier('h', () => {})]]);
  playRounds(g2, vs2, 25, r);
  assert.deepEqual(vs.get('c2').alerts, []);
  assert.deepEqual(vs2.get('h').alerts, []);
  assert.ok(vs.get('c2').roundsOk > 20);
});

t('cambio de host entre manos: nada se pierde', () => {
  const { g, vs, tok, r } = hostChangeTable();
  playRounds(g, vs, 5, r);
  const chips = Object.fromEntries(Object.values(g.players).map((p) => [p.id, p.chips]));
  const { game: g2, voided } = G.fromState(G.publicState(g), 'c2');
  assert.equal(voided, false);
  for (const id in chips) assert.equal(g2.players[id].chips, chips[id]);
  G.joinPlayer(g2, 'Host', tok.h, 'z');
  G.joinPlayer(g2, 'Uno', tok.c1, 'z');
  const vs2 = new Map([['c1', vs.get('c1')], ['h', new Verifier('h', () => {})]]);
  playRounds(g2, vs2, 10, r);
  assert.deepEqual(vs.get('c1').alerts, []);
});

t('trampa: el host nuevo se suma fichas al tomar la mesa', () => {
  const { g, vs, tok, r } = hostChangeTable();
  playRounds(g, vs, 4, r);
  const { game: g2 } = G.fromState(G.publicState(g), 'c1');
  g2.players.c1.chips += 50000;
  G.joinPlayer(g2, 'Dos', tok.c2, 'z');
  playRounds(g2, new Map([['c2', vs.get('c2')]]), 2, r);
  assert.ok(vs.get('c2').alerts.some((a) => /fichas de Uno/.test(a)), vs.get('c2').alerts.join(' | '));
});

console.log(`OK ${n} tests`);
