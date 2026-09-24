// Se ejecuta cada 10 minutos en GitHub Actions.
// Revisa los comunicados activos y envía el aviso o el recordatorio a quien no ha confirmado.
const admin = require("firebase-admin");

const cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!cuenta.project_id) { console.error("Falta el secreto FIREBASE_SERVICE_ACCOUNT en GitHub."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(cuenta) });

const db = admin.firestore();
const messaging = admin.messaging();
const { FieldValue, Timestamp } = admin.firestore;
const APP_URL = (process.env.APP_URL || "").replace(/\/?$/, "/");
const TOKENS_INVALIDOS = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"];

async function main() {
  const ahora = new Date();
  const snap = await db.collection("comunicados").where("activo", "==", true).get();
  console.log(`${ahora.toISOString()} — comunicados activos: ${snap.size}`);
  const usuarios = new Map();
  const perfil = async (uid) => {
    if (!usuarios.has(uid)) usuarios.set(uid, (await db.doc(`users/${uid}`).get()).data() || {});
    return usuarios.get(uid);
  };

  for (const d of snap.docs) {
    const c = d.data();
    const confirmados = new Set(c.confirmados || []);
    const pendientes = (c.destinatarios || []).filter((u) => !confirmados.has(u));
    const hasta = c.hasta?.toDate();
    const proximo = c.proximoEnvio?.toDate();

    if (!pendientes.length) { await d.ref.update({ activo: false, motivoFin: "todos confirmaron" }); continue; }
    if (c.enviosRealizados > 0 && hasta && hasta < ahora) { await d.ref.update({ activo: false, motivoFin: "fecha límite" }); continue; }
    if (!proximo || proximo > ahora) continue;

    const esPrimero = !c.enviosRealizados;
    const titulo = esPrimero ? `📢 ${c.titulo}` : `🔔 Recordatorio: ${c.titulo}`;
    const cuerpo = (c.mensaje || "").slice(0, 180) + (esPrimero ? "" : "\nToca para confirmar la lectura.");

    const mensajes = [], origen = [];
    for (const uid of pendientes) {
      for (const token of (await perfil(uid)).tokens || []) {
        mensajes.push({
          token,
          data: { comunicadoId: d.id },
          webpush: {
            notification: { title: titulo, body: cuerpo, requireInteraction: true, tag: d.id, renotify: true, icon: APP_URL + "icon-192.png" },
            fcmOptions: { link: `${APP_URL}?c=${d.id}` }
          }
        });
        origen.push({ uid, token });
      }
    }

    let ok = 0;
    if (mensajes.length) {
      const r = await messaging.sendEach(mensajes);
      ok = r.successCount;
      for (const [i, res] of r.responses.entries()) {
        if (!res.success && TOKENS_INVALIDOS.includes(res.error?.code)) {
          await db.doc(`users/${origen[i].uid}`).update({ tokens: FieldValue.arrayRemove(origen[i].token) });
        } else if (!res.success) console.warn("Error de envío:", res.error?.code, res.error?.message);
      }
    }
    console.log(`"${c.titulo}": ${pendientes.length} pendientes, ${ok}/${mensajes.length} notificaciones entregadas`);

    const cambios = { ultimoEnvio: Timestamp.fromDate(ahora), enviosRealizados: FieldValue.increment(1) };
    const cada = c.repetirCadaMin || 0;
    const siguiente = new Date(ahora.getTime() + cada * 60000);
    if (cada > 0 && (!hasta || siguiente <= hasta)) cambios.proximoEnvio = Timestamp.fromDate(siguiente);
    else Object.assign(cambios, { activo: false, motivoFin: cada > 0 ? "fecha límite" : "envío único" });
    await d.ref.update(cambios);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
