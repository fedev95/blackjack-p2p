// Verificador que corre en cada jugador (no en el host). Garantiza que el host no pueda hacer trampa:
//  - Por cada mano genera una cadena secreta y manda solo su ancla (hash). Para cada carta revela el
//    siguiente eslabón, y solo cuando corresponde: nunca por adelantado.
//  - Verifica que cada carta salga exactamente de lo revelado por todos.
//  - Exige que el host anuncie la jugada ANTES de pedir la carta, y después controla que haya aplicado
//    esa misma jugada (así no puede "probar" cartas y después decidir).
//  - Re-simula la mano completa (reglas, banca, pagos) y controla fichas, apuestas y jugadas propias.

import * as G from './game.js';

const sameCard = (a, b) => !!a && !!b && a.r === b.r && a.s === b.s;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class Verifier {
  constructor(myId, send) {
    this.myId = myId;
    this.send = send;
    this.chains = new Map(); // roundNo -> mi cadena secreta
    this.rounds = new Map(); // roundNo -> registro de verificación
    this.audited = new Set();
    this.last = null;
    this.betSeen = null;
    this.sent = []; // jugadas que mandé en la mano actual
    this.expected = null; // fichas esperadas de cada jugador entre manos (después de compras y recargas)
    this.lastShopSeq = 0;
    this.myBuys = []; // compras que pedí y todavía no vi
    this.alerts = [];
    this.partialRound = undefined; // mano que ya estaba en juego cuando arrancó este verificador (ej. recargaste)
    this.notices = []; // avisos que no son necesariamente trampa (ej. alguien quedó fuera del sorteo)
    this.roundsOk = 0;
    this.cardsOk = 0;
  }

  alert(msg) {
    if (!this.alerts.includes(msg)) this.alerts.push(msg);
  }

  onState(s) {
    try {
      this.check(s);
    } catch (e) {
      this.alert('El host mandó un estado inválido');
    }
    this.last = s;
  }

  noteBuy(item, to) {
    this.myBuys.push({ item, to });
  }

  noteAction(a) {
    if (this.last) this.sent.push({ round: this.last.roundNo, a });
  }

  // Compras de la tienda: precios del catálogo y nadie compra con mis fichas sin que yo lo pida.
  checkShop(s) {
    for (const e of s.shopLog || []) {
      if (e.seq <= this.lastShopSeq) continue;
      this.lastShopSeq = e.seq;
      if (e.kind === 'rebuy') {
        const d = G.rebuyDraw(s, e.pid, e.n);
        const name = s.players[e.pid]?.name ?? '?';
        if (d.amount !== e.amount || d.line !== e.line) this.alert(`El host inventó el monto de las fichas que pidió ${name}`);
        if (this.expected && this.expected[e.pid] !== undefined) {
          if (this.expected[e.pid] >= s.rules.minBet) this.alert(`${name} pidió fichas sin haberse quedado sin`);
          this.expected[e.pid] += e.amount;
        }
        continue;
      }
      const it = G.shopItem(e.item);
      if (!it || it.price !== e.price) {
        this.alert('El host cobró un precio falso en la tienda');
        continue;
      }
      if (this.expected && this.expected[e.buyer] !== undefined) this.expected[e.buyer] -= e.price;
      if (e.buyer === this.myId) {
        const i = this.myBuys.findIndex((b) => b.item === e.item && b.to === e.to);
        if (i === -1) this.alert('El host compró en la tienda con tus fichas sin que lo pidieras');
        else this.myBuys.splice(i, 1);
      }
    }
  }

  // Entre manos las fichas solo cambian por compras (ya descontadas) o por la recarga.
  checkBetweenHands(s) {
    if (!this.expected || (s.phase !== 'betting' && s.phase !== 'done')) return;
    for (const p of Object.values(s.players)) {
      const exp = this.expected[p.id];
      if (exp === undefined || p.chips === exp) continue;
      this.alert(`Las fichas de ${p.name} cambiaron entre manos`);
      this.expected[p.id] = p.chips;
    }
  }

  check(s) {
    if (this.partialRound === undefined) this.partialRound = s.phase === 'betting' ? null : s.roundNo;
    this.checkShop(s);
    // en el resultado de una mano, solo después de auditarla (antes las fichas reflejan los pagos)
    if (s.phase === 'betting' || (s.phase === 'done' && this.audited.has(s.roundNo))) this.checkBetweenHands(s);
    if (s.phase === 'betting') {
      // Compromiso para la próxima mano
      const R = s.roundNo + 1;
      if (!this.chains.has(R)) {
        const chain = G.makeChain(s.rules.chainLength);
        this.chains.set(R, chain);
        for (const r of this.chains.keys()) if (r < R - 1) this.chains.delete(r);
        this.send({ t: 'anchor', round: R, anchor: chain[0] });
      } else {
        const mine = s.fair.nextAnchors[this.myId];
        if (mine && mine !== this.chains.get(R)[0]) this.alert('El host alteró tu compromiso');
        // host nuevo (o se perdió el mensaje): reenviar el mismo compromiso, como mucho cada 2 s
        if (!mine && s.players[this.myId]?.connected && Date.now() - (this.anchorSentAt || 0) > 2000) {
          this.anchorSentAt = Date.now();
          this.send({ t: 'anchor', round: R, anchor: this.chains.get(R)[0] });
        }
      }
      const me = s.players[this.myId];
      this.betSeen = me ? me.bet : null;
      this.sent = [];
      return;
    }
    if (s.roundNo > 0) this.checkRound(s);
    if (s.phase === 'done' && !this.audited.has(s.roundNo)) this.audit(s);
  }

  checkRound(s) {
    const R = s.roundNo;
    const f = s.fair;
    let rec = this.rounds.get(R);
    if (!rec) {
      rec = {
        contributors: f.contributors.slice(),
        anchors: { ...f.anchors },
        last: { ...f.anchors },
        dropped: [],
        cards: [],
        reqs: new Map(),
        revealedUpTo: 0,
        betSeen: this.betSeen,
      };
      this.rounds.set(R, rec);
      for (const r of this.rounds.keys()) if (r < R - 2) this.rounds.delete(r);
      const expected = [G.HOST, ...s.round.filter((id) => id !== s.hostId)];
      if (!same(expected, f.contributors)) this.alert('El host armó mal la lista del sorteo de cartas');
      const imIn = s.round.includes(this.myId);
      // si llegué con la mano empezada no tengo mi cadena de esa mano: no se puede reclamar nada propio
      const mine = R !== this.partialRound;
      if (mine && imIn && this.myId !== s.hostId) {
        const chain = this.chains.get(R);
        if (!chain || f.anchors[this.myId] !== chain[0]) this.alert('El host no usó tu compromiso para el sorteo');
      }
      if (mine && !imIn && rec.betSeen > 0 && s.players[this.myId]?.connected) this.alert('El host te dejó afuera de la mano aunque apostaste');
    } else if (!same(rec.contributors, f.contributors) || !same(rec.anchors, f.anchors)) {
      this.alert('El host cambió el sorteo a mitad de mano');
      return;
    }

    // Exclusiones: solo hacia adelante, nunca sobre cartas ya publicadas
    for (const d of f.dropped) {
      if (rec.dropped.some((x) => same(x, d))) continue;
      if (d.k < rec.cards.length) this.alert('El host excluyó a alguien del sorteo de forma retroactiva');
      rec.dropped.push(d);
      if (d.cid === this.myId && R === this.partialRound) {
        // normal: al recargar perdí mi cadena de esta mano, no puedo seguir aportando al sorteo
      } else if (d.cid === this.myId) {
        this.alert(rec.revealedUpTo > d.k ? 'El host te excluyó del sorteo aunque respondiste a tiempo' : 'El host te excluyó del sorteo de cartas');
      } else {
        const name = s.players[d.cid]?.name ?? '?';
        const msg = `Mano ${R}: ${name} quedó fuera del sorteo de cartas (se desconectó o el host lo excluyó)`;
        if (!this.notices.includes(msg)) this.notices.push(msg);
        if (this.notices.length > 5) this.notices.shift();
      }
    }
    if (rec.dropped.length !== f.dropped.length) this.alert('El host borró exclusiones del sorteo');

    // Las cartas ya publicadas no cambian
    for (let k = 0; k < rec.cards.length; k++) {
      if (!sameCard(rec.cards[k], s.cards[k])) {
        this.alert('El host cambió una carta ya repartida');
        return;
      }
    }
    // Cada carta nueva tiene que salir del sorteo
    for (let k = rec.cards.length; k < s.cards.length; k++) {
      const rev = f.reveals[k] || {};
      const active = G.activeContributors(f, k);
      for (const c of active) {
        const v = rev[c];
        if (typeof v !== 'string' || G.chainStep(v) !== rec.last[c]) {
          this.alert(`Revelación inválida en la carta ${k + 1}`);
          return;
        }
        rec.last[c] = v;
      }
      const card = G.cardFromValues(s.rules, R, k, active.map((c) => rev[c]), s.cards.slice(0, k));
      if (!sameCard(card, s.cards[k])) {
        this.alert(`La carta ${k + 1} no sale del sorteo`);
        return;
      }
      rec.cards.push(card);
      this.cardsOk++;
    }
  }

  // Pedido del host para revelar mis valores de las cartas k..k+n-1. Devuelve los valores o null.
  // Un pedido fuera de lugar es un intento de ver cartas antes de tiempo: se rechaza y se avisa.
  onRevealRequest(m) {
    const s = this.last;
    if (!s || !m) return null;
    const chain = this.chains.get(m.round);
    const rec = this.rounds.get(m.round);
    if (s.roundNo !== m.round || !chain || !rec) return null; // mano que no conozco (entré tarde)
    if (!G.activeContributors(s.fair, s.cards.length).includes(this.myId)) return null;
    const bad = (why) => {
      this.alert(`El host pidió una carta fuera de lugar (${why})`);
      return null;
    };
    const { k, n, act, pending } = m;
    if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k + n >= chain.length) return bad('pedido inválido');
    if (k !== s.cards.length) return bad('carta salteada');
    if (act === -1) {
      // reparto inicial (de una) o 2ª carta de la banca si la mano termina sin jugadas
      if (s.phase !== 'dealing') return bad('sin jugada anunciada');
      const first = 2 * s.round.length + 1;
      if (!((k === 0 && n === first) || (k >= first && n === 1))) return bad('reparto inválido');
    } else {
      // carta para una jugada anunciada: tiene que ser la próxima y ser válida en el estado actual
      if (s.phase !== 'playing' || n !== 1 || act !== s.roundLog.actions.length) return bad('jugada fuera de orden');
      if (!pending || !s.turn || pending.pid !== s.turn.pid) return bad('no es el turno de ese jugador');
      if (!G.legalActions(s, pending.pid).includes(pending.a)) return bad('jugada no permitida');
      // nadie puede jugar por mí (salvo plantarme por tiempo)
      if (pending.pid === this.myId && pending.a !== 'stand' && !this.sent.some((x) => x.round === s.roundNo && x.a === pending.a)) {
        return bad('una jugada tuya que no hiciste');
      }
    }
    for (let i = 0; i < n; i++) rec.reqs.set(k + i, { act, pending: act === -1 ? null : { pid: pending.pid, a: pending.a } });
    rec.revealedUpTo = Math.max(rec.revealedUpTo, k + n);
    return chain.slice(k + 1, k + 1 + n);
  }

  audit(s) {
    const R = s.roundNo;
    this.audited.add(R);
    const rec = this.rounds.get(R);
    const res = G.auditRound(s);
    if (res.ok === false) {
      this.alert(`Mano ${R}: ${res.reason}`);
    } else if (res.ok) {
      let ok = true;
      if (rec) {
        if (rec.cards.length !== s.cards.length) {
          this.alert(`Mano ${R}: hay cartas sin verificar`);
          ok = false;
        }
        // cada carta que ayudé a sortear se usó en la jugada que el host anunció
        for (const [k, req] of rec.reqs) {
          if (res.cardActs[k] !== req.act) {
            this.alert(`Mano ${R}: el host pidió una carta antes de tiempo`);
            ok = false;
            break;
          }
          if (req.act >= 0) {
            const a = s.roundLog.actions[req.act];
            if (!a || a.pid !== req.pending.pid || a.a !== req.pending.a) {
              this.alert(`Mano ${R}: el host anunció una jugada y aplicó otra`);
              ok = false;
              break;
            }
          }
        }
      }
      if (ok) this.roundsOk++;
    }

    const L = s.roundLog;
    if (!L) return;
    // mi apuesta y mis jugadas
    const mine = L.participants.find((p) => p.id === this.myId);
    const betSeen = rec ? rec.betSeen : null;
    if (mine && betSeen !== null && mine.bet !== betSeen) this.alert('El host cambió tu apuesta');
    const sent = this.sent.filter((x) => x.round === R).map((x) => x.a);
    for (const a of L.actions) {
      if (a.pid !== this.myId || a.auto || a.a === 'stand') continue;
      const i = sent.indexOf(a.a);
      if (i === -1) {
        this.alert(`Mano ${R}: el host jugó por vos`);
        break;
      }
      sent.splice(0, i + 1);
    }
    // fichas: las de arranque de la mano tienen que ser las esperadas (resultado anterior - compras + recarga)
    if (this.expected) {
      for (const p of Object.values(s.players)) {
        const exp = this.expected[p.id];
        if (exp === undefined) continue;
        const part = L.participants.find((q) => q.id === p.id);
        const now = part ? part.chips : p.chips;
        if (now !== exp) this.alert(`Las fichas de ${p.name} cambiaron entre manos`);
      }
    }
    this.expected = Object.fromEntries(Object.values(s.players).map((p) => [p.id, p.chips]));
  }
}
