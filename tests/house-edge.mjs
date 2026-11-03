import * as G from '../game.js';
function bs(h, up, legal) {
  const d = up === 'A' ? 11 : G.cardValue(up);
  const { total, soft } = G.handValue(h.cards);
  const can = (a) => legal.includes(a);
  if (can('split')) {
    const r = G.cardValue(h.cards[0].r);
    const sp = { 1: true, 8: true, 9: [2,3,4,5,6,8,9].includes(d), 7: d <= 7, 6: d <= 6, 4: d === 5 || d === 6, 2: d <= 7, 3: d <= 7 }[r];
    if (sp) return 'split';
  }
  const D = (cond) => (cond && can('double') ? 'double' : null);
  if (soft) {
    if (total >= 19) return 'stand';
    if (total === 18) return D(d >= 3 && d <= 6) || (d <= 8 ? 'stand' : 'hit');
    if (total === 17) return D(d >= 3 && d <= 6) || 'hit';
    if (total >= 15) return D(d >= 4 && d <= 6) || 'hit';
    return D(d >= 5 && d <= 6) || 'hit';
  }
  if (total >= 17) return 'stand';
  if (total >= 13) return d <= 6 ? 'stand' : 'hit';
  if (total === 12) return d >= 4 && d <= 6 ? 'stand' : 'hit';
  if (total === 11) return D(d <= 10) || 'hit';
  if (total === 10) return D(d <= 9) || 'hit';
  if (total === 9) return D(d >= 3 && d <= 6) || 'hit';
  return 'hit';
}
const g = G.createGame(); G.addPlayer(g, 'a', 'a');
let wag = 0, net = 0; const N = 3e6;
for (let i = 0; i < N; i++) {
  g.players.a.chips = 1e12; G.placeBet(g, 'a', 10); const b = g.players.a.chips; G.deal(g);
  while (g.phase === 'playing') { const h = g.players.a.hands[g.turn.hand]; G.act(g, 'a', bs(h, g.dealer.cards[0].r, G.legalActions(g, 'a'))); }
  wag += 10; net += g.players.a.chips - b; G.nextRound(g);
}
console.log('EV basic strategy:', (net / wag * 100).toFixed(3) + '%  (esperado ≈ -0.4%..-0.6%)');
