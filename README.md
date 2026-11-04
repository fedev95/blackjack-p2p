# Blackjack P2P

Blackjack multijugador en el navegador, peer to peer (WebRTC con [PeerJS](https://peerjs.com/)). Sin servidor ni build: son archivos estáticos.

## Cómo jugar

1. Uno crea la sala, **pública** (entra cualquiera con el link) o **privada** (además hace falta un PIN de 6 dígitos). Su navegador coordina la partida. Si se va, otro jugador toma su lugar automáticamente con el mismo código de sala (una mano a medio jugar se anula y se devuelven las apuestas).
2. Comparte el link de invitación (y el PIN por otro lado, si es privada). Entran hasta 7 jugadores.
3. La partida corre sola: 15 s para apostar, 20 s por jugada (si no, se planta solo), 6 s entre manos.

## Reglas

- 6 mazos con mezcla continua (el mazo se rearma en cada mano).
- **Regla europea:** la banca recibe una carta al repartir y la segunda al final, después de que todos jugaron. Si tiene Blackjack, solo se pierde la apuesta original: lo doblado o dividido se devuelve (equivale a la regla americana con carta tapada).
- La banca se planta en todos los 17.
- Blackjack paga 3:2; un 21 después de dividir paga 1:1.
- Doblar con las 2 primeras cartas, también después de dividir.
- Dividir pares del mismo valor hasta 4 manos; los ases divididos reciben una sola carta.
- Sin seguro ni rendición. 1000 fichas iniciales, apuestas en múltiplos de 10.

## Tienda

Entre manos (mientras se apuesta o al terminar una mano) se pueden comprar consumibles con fichas, para uno mismo o de regalo para otro jugador: café, mate, bebidas, cigarrillos, puros y comidas. Cada uno dura algunas manos y se muestra al lado del nombre del jugador (con 🎁 si fue regalo). Cada jugador puede tener un solo consumible a la vez; se puede terminar antes para comprar otro. Lo apostado no se puede gastar.

Las compras quedan en un registro público: cada jugador verifica precios y que nadie compre con sus fichas sin pedirlo, y las descuenta al cuadrar las fichas entre manos.

## Seguridad (P2P, sin servidor)

El que crea la sala coordina la partida, pero **no tiene ninguna ventaja ni puede hacer trampa sin que se note**:

- **Cada carta se sortea entre todos.** Al empezar la mano, cada jugador genera una cadena de hashes secreta y publica solo su extremo (compromiso). Para cada carta, todos revelan el siguiente eslabón y la carta sale de `SHA-256(todos los valores)`. Nadie, ni el host, puede saber una carta antes de que salga, ni cambiar su aporte después.
- **No hay cartas ocultas.** Con la regla europea no existe la carta tapada, así que no hay nada secreto que espiar.
- **Primero la jugada, después la carta.** El host tiene que anunciar qué jugada consume cada carta antes de sortearla; los jugadores rechazan pedidos fuera de lugar y al final verifican que se aplicó exactamente esa jugada.
- **Auditoría de cada mano:** cada jugador verifica cada carta y re-simula la mano completa (reparto, banca, pagos, fichas). Cualquier diferencia muestra una alerta roja.
- **Lo único que puede hacer un host tramposo** es excluir a un jugador del sorteo de una mano (igual que si se hubiera desconectado). El afectado ve una alerta y los demás un aviso.
- **Salas privadas con PIN:** el PIN viaja cifrado (WebRTC/DTLS) y se compara en tiempo constante; máximo 5 intentos fallidos por minuto.
- **Tu lugar es tuyo:** token secreto por jugador para reconectarse.
- **Robustez:** límite de mensajes, conexiones sin identificar se cortan a los 10 s, validación estricta, nombres saneados, nada del host se inserta como HTML sin escapar, PeerJS copiado en `vendor/`, CSP y headers de seguridad en `netlify.toml`.

## Archivos

- `game.js`: lógica pura del juego (sin DOM ni red) y auditoría de manos.
- `fair.js`: SHA-256, cadenas de hashes y sorteo determinístico a partir de los valores revelados.
- `verify.js`: verificador que corre en cada jugador (responde los sorteos y audita al host).
- `app.js`: red (PeerJS), salas/PIN, relojes de la partida e interfaz.
- `vendor/`: PeerJS 1.5.4.
- `net-config.js`: servidores STUN/TURN. Para redes donde la conexión directa falla (algunos datos móviles o wifi de empresa), pegá ahí credenciales de un TURN propio (por ejemplo, la cuenta gratis de Metered).
- `index.html`: página y estilos.

## Tests

Requiere Node 18+.

```sh
node tests/game.test.mjs   # reglas, 50.000 manos aleatorias, protocolo P2P completo y trampas simuladas del host
node tests/house-edge.mjs  # 3M de manos con estrategia básica: ventaja de la casa ≈ 0,4-0,5%
```

## Deploy

Netlify (u otro hosting estático) publicando la raíz del repo.
