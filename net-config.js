// Servidores para establecer la conexión entre navegadores (WebRTC).
//
// STUN: ayuda a que dos navegadores se conecten directo atravesando el router. Gratis y sin cuenta.
// TURN: respaldo para redes donde la conexión directa no funciona (algunos datos móviles, wifi de
// empresa o facultad). Retransmite el tráfico cifrado: no puede leerlo ni modificarlo.
//
// Para tener TURN confiable, creá una cuenta gratis (por ejemplo en https://www.metered.ca/stun-turn,
// 50 GB/mes) y pegá acá las credenciales que te dan. Quedan visibles en el código del sitio, así que
// cualquiera con el link podría usar tu cupo: está bien para jugar con amigos.
export const TURN_SERVERS = [
  // { urls: ['turn:xxxx.relay.metered.ca:80', 'turn:xxxx.relay.metered.ca:443?transport=tcp'], username: '...', credential: '...' },
];

export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // TURN público de PeerJS: sin garantías (en las pruebas no respondió), se deja como último recurso
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ...TURN_SERVERS,
];

export const PEER_OPTIONS = { config: { iceServers: ICE_SERVERS } };
