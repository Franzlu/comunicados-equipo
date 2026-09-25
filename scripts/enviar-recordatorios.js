// Se ejecuta cada 5 minutos en GitHub Actions (y al instante cuando la app lo pide).
// Revisa los comunicados activos y envía los avisos que ya tocan.
const admin = require("firebase-admin");

const cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!cuenta.project_id) { console.error("Falta el secreto FIREBASE_SERVICE_ACCOUNT en GitHub."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(cuenta) });

const db = admin.firestore();
const messaging = admin.messaging();
const { FieldValue, Timestamp } = admin.firestore;
const APP_URL = (process.env.APP_URL || "").replace(/\/?$/, "/");
// Margen para no llegar tarde entre turnos (el aviso de "empieza ahora" casi sin adelanto)
const ADELANTO = 2 * 60000;
const adelanto = (tipo) => (tipo === "inicio" ? 30000 : ADELANTO);
const TOKENS_INVALIDOS = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"];

const usuarios = new Map();
async function perfil(uid) {
  if (!usuarios.has(uid)) usuarios.set(uid, (await db.doc(`users/${uid}`).get()).data() || {});
  return usuarios.get(uid);
}

// ttlSeg: si el dispositivo está apagado más tiempo que esto, el aviso se descarta
// (así nadie recibe tarde un recordatorio que ya no sirve)
async function notificar(id, uids, titulo, cuerpo, ttlSeg) {
  const ttl = String(Math.max(60, Math.round(ttlSeg || 86400)));
  const mensajes = [], origen = [];
  for (const uid of uids) {
    for (const token of (await perfil(uid)).tokens || []) {
      mensajes.push({
        token,
        data: { comunicadoId: id },
        webpush: {
          headers: { TTL: ttl, Urgency: "high" },
          notification: { title: titulo, body: cuerpo, requireInteraction: true, tag: id, renotify: true, icon: APP_URL + "icon-192.png" },
          fcmOptions: { link: `${APP_URL}?c=${id}` }
        }
      });
      origen.push({ uid, token });
    }
  }
  if (!mensajes.length) return "0/0";
  const r = await messaging.sendEach(mensajes);
  for (const [i, res] of r.responses.entries()) {
    if (res.success) continue;
    if (TOKENS_INVALIDOS.includes(res.error?.code)) {
      await db.doc(`users/${origen[i].uid}`).update({ tokens: FieldValue.arrayRemove(origen[i].token) });
    } else console.warn("Error de envío:", res.error?.code, res.error?.message);
  }
  return `${r.successCount}/${mensajes.length}`;
}

// Comunicado de tipo evento: sigue un calendario fijo de avisos
async function procesarEvento(d, c, ahora, pendientes) {
  const programa = (c.programa || []).map((p) => ({ en: p.en.toDate(), tipo: p.tipo }));
  let idx = c.indiceEnvio || 0;
  let ultimo = -1;
  while (idx < programa.length && programa[idx].en.getTime() <= ahora.getTime() + adelanto(programa[idx].tipo)) { ultimo = idx; idx++; }
  if (ultimo < 0) return;

  const paso = programa[ultimo]; // si se juntaron varios, se envía solo el más reciente
  const zona = c.zonaHoraria || "UTC";
  const ev = c.eventoEn.toDate();
  const horaEv = ev.toLocaleTimeString("es", { hour: "numeric", minute: "2-digit", timeZone: zona });
  const diaEv = ev.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long", timeZone: zona });

  let titulo, cuerpo, uids;
  if (paso.tipo === "inicial") {
    titulo = `📢 ${c.titulo}`;
    cuerpo = `🗓 ${diaEv}, ${horaEv}\n${(c.mensaje || "").slice(0, 160)}`;
    uids = pendientes;
  } else {
    titulo = paso.tipo === "antes" ? `⏰ En 10 minutos: ${c.titulo}`
      : paso.tipo === "inicio" ? `⏰ Empieza ahora: ${c.titulo}`
      : `⏰ Hoy a las ${horaEv}: ${c.titulo}`;
    cuerpo = (c.mensaje || "").slice(0, 160);
    uids = c.recordarATodos ? c.destinatarios || [] : pendientes;
  }
  const vence = paso.tipo === "inicio" ? ev.getTime() + 15 * 60000
    : idx < programa.length ? programa[idx].en.getTime() : ev.getTime();
  const res = uids.length ? await notificar(d.id, uids, titulo, cuerpo, (vence - ahora.getTime()) / 1000) : "0/0";
  console.log(`[evento] "${c.titulo}" — aviso ${ultimo + 1}/${programa.length} (${paso.tipo}): ${res} notificaciones entregadas`);

  const cambios = { ultimoEnvio: Timestamp.fromDate(ahora), enviosRealizados: FieldValue.increment(1), indiceEnvio: idx };
  if (idx < programa.length) cambios.proximoEnvio = Timestamp.fromDate(programa[idx].en);
  else Object.assign(cambios, { activo: false, motivoFin: "evento iniciado" });
  await d.ref.update(cambios);
}

// Aviso general: se repite cada cierto tiempo a quien no ha confirmado
async function procesarAviso(d, c, ahora, pendientes) {
  const hasta = c.hasta?.toDate();
  const proximo = c.proximoEnvio?.toDate();
  if (c.enviosRealizados > 0 && hasta && hasta < ahora) { await d.ref.update({ activo: false, motivoFin: "fecha límite" }); return; }
  if (!proximo || proximo.getTime() > ahora.getTime() + ADELANTO) return;

  const esPrimero = !c.enviosRealizados;
  const titulo = esPrimero ? `📢 ${c.titulo}` : `🔔 Recordatorio: ${c.titulo}`;
  const cuerpo = (c.mensaje || "").slice(0, 180) + (esPrimero ? "" : "\nToca para confirmar la lectura.");
  const res = await notificar(d.id, pendientes, titulo, cuerpo, (c.repetirCadaMin || 1440) * 60);
  console.log(`[aviso] "${c.titulo}": ${pendientes.length} pendientes, ${res} notificaciones entregadas`);

  const cambios = { ultimoEnvio: Timestamp.fromDate(ahora), enviosRealizados: FieldValue.increment(1) };
  const cada = c.repetirCadaMin || 0;
  const siguiente = new Date(Math.max(ahora.getTime(), proximo.getTime()) + cada * 60000);
  if (cada > 0 && (!hasta || siguiente <= hasta)) cambios.proximoEnvio = Timestamp.fromDate(siguiente);
  else Object.assign(cambios, { activo: false, motivoFin: cada > 0 ? "fecha límite" : "envío único" });
  await d.ref.update(cambios);
}

async function main() {
  const ahora = new Date();
  const snap = await db.collection("comunicados").where("activo", "==", true).get();
  console.log(`${ahora.toISOString()} — comunicados activos: ${snap.size}`);

  for (const d of snap.docs) {
    const c = d.data();
    const confirmados = new Set(c.confirmados || []);
    const pendientes = (c.destinatarios || []).filter((u) => !confirmados.has(u));
    if (!pendientes.length && !(c.tipo === "evento" && c.recordarATodos)) {
      await d.ref.update({ activo: false, motivoFin: "todos confirmaron" }); continue;
    }
    if (c.tipo === "evento") await procesarEvento(d, c, ahora, pendientes);
    else await procesarAviso(d, c, ahora, pendientes);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
