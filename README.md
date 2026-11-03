# Blackjack P2P

Blackjack multijugador en el navegador, peer to peer (WebRTC con [PeerJS](https://peerjs.com/)). Sin servidor ni build: son archivos estáticos.

## Cómo jugar

1. Uno crea la sala. Su navegador hace de servidor: tiene el mazo y valida todas las jugadas, así nadie puede ver cartas ocultas. No tiene que cerrar la pestaña.
2. Comparte el link de invitación. Entran hasta 7 jugadores.
3. La partida corre sola: 15 s para apostar, 20 s por jugada (si no, se planta solo), 6 s entre manos.

## Reglas

- 6 mazos, se rebaraja al quedar menos del 25% del zapato.
- La banca se planta en todos los 17 y chequea blackjack si muestra As o 10.
- Blackjack paga 3:2; un 21 después de dividir paga 1:1.
- Doblar con las 2 primeras cartas, también después de dividir.
- Dividir pares del mismo valor hasta 4 manos; los ases divididos reciben una sola carta.
- Sin seguro ni rendición. 1000 fichas iniciales, apuestas en múltiplos de 10.

## Archivos

- `game.js`: lógica pura del juego (sin DOM ni red).
- `app.js`: red (PeerJS), relojes de la partida e interfaz.
- `index.html`: página y estilos.

## Tests

Requiere Node 18+.

```sh
node tests/game.test.mjs   # casos de reglas + 50.000 rondas aleatorias con invariantes
node tests/house-edge.mjs  # 3M de manos con estrategia básica: ventaja de la casa ≈ 0,4%
```

## Deploy

Netlify (u otro hosting estático) publicando la raíz del repo.
