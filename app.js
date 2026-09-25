import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, getDocs, collection, query, where, onSnapshot, addDoc,
  updateDoc, deleteDoc, serverTimestamp, Timestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { firebaseConfig, VAPID_KEY, ADMIN_EMAIL } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

let yo = null, esAdmin = false, pestanaActual = "mis";
let misComunicados = [], todosComunicados = [], usuarios = [], grupos = [];
let desuscribir = [], primeraCarga = true, ghToken = "";
const GITHUB_REPO = "Franzlu/comunicados-equipo";
let destacar = new URLSearchParams(location.search).get("c");
const abiertoDesdeAviso = destacar;

/* ---------- Utilidades ---------- */
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
}
const fecha = (ts) => ts?.toDate ? ts.toDate().toLocaleString("es", { dateStyle: "medium", timeStyle: "short" }) : "";
const aLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const nombreDe = (uid) => usuarios.find((u) => u.id === uid)?.nombre || "Sin nombre";
const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const instalada = matchMedia("(display-mode: standalone)").matches || navigator.standalone;

// Alarma que se repite hasta que la persona atienda el aviso
let ctxAudio = null, bucleAlarma = null, parpadeo = null;
const tituloOriginal = document.title;
function audio() {
  if (!ctxAudio) {
    try { ctxAudio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    ctxAudio.onstatechange = () => typeof revisarSonido === "function" && revisarSonido();
  }
  if (ctxAudio.state === "suspended") ctxAudio.resume().catch(() => {});
  return ctxAudio;
}
// El navegador solo permite sonido después de un primer clic en la página.
// Mientras no esté permitido, se muestra una barra para activarlo con un toque.
const barraSonido = document.createElement("button");
barraSonido.textContent = "🔇 Las alarmas están en silencio. Toca aquí para activar el sonido.";
barraSonido.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:150;border:0;padding:14px 20px calc(14px + env(safe-area-inset-bottom,0px));background:#D1495B;color:#fff;font:700 16px var(--texto);cursor:pointer;display:none";
document.body.appendChild(barraSonido);
function revisarSonido() {
  const ctx = audio();
  barraSonido.style.display = yo && ctx && ctx.state !== "running" ? "block" : "none";
}
barraSonido.onclick = async () => { await audio()?.resume().catch(() => {}); pitido(); revisarSonido(); };
addEventListener("pointerdown", () => { audio(); setTimeout(revisarSonido, 300); });
setInterval(revisarSonido, 3000);
function pitido() {
  const ctx = audio(); if (!ctx) return;
  [0, 0.22, 0.44].forEach((t, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "square"; o.frequency.value = i === 2 ? 1175 : 880;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.18, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18);
    o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
  });
}
function iniciarAlarma() {
  detenerAlarma(); pitido();
  bucleAlarma = setInterval(pitido, 1600);
  let v = false; // el título parpadea en la barra de tareas
  parpadeo = setInterval(() => { document.title = (v = !v) ? "🔔 AVISO PENDIENTE" : tituloOriginal; }, 1000);
  navigator.setAppBadge?.(1).catch(() => {});
}
function detenerAlarma() {
  clearInterval(bucleAlarma); clearInterval(parpadeo); bucleAlarma = parpadeo = null;
  document.title = tituloOriginal; navigator.clearAppBadge?.().catch(() => {});
}

// Mensajes del service worker: llegó un aviso o se cerró la notificación
navigator.serviceWorker?.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.tipo === "aviso-push" && m.comunicadoId) mostrarInterrupcion(m.comunicadoId, true, { title: m.title, body: m.body }, true);
  if (m.tipo === "aviso-cerrado" && m.comunicadoId === enPantalla) detenerAlarma();
  if (m.tipo === "aviso-abierto" && m.comunicadoId && enPantalla !== m.comunicadoId) mostrarInterrupcion(m.comunicadoId, true, { title: m.title }, true);
});

/* ---------- Acceso ---------- */
let modoRegistro = false;
$("btnAlternar").onclick = () => {
  modoRegistro = !modoRegistro;
  $("campoNombre").classList.toggle("oculto", !modoRegistro);
  $("inNombre").required = modoRegistro;
  $("btnAcceso").textContent = modoRegistro ? "Crear cuenta" : "Entrar";
  $("btnAlternar").textContent = modoRegistro ? "Ya tengo cuenta: entrar" : "Es mi primera vez: crear cuenta";
  $("inClave").autocomplete = modoRegistro ? "new-password" : "current-password";
  $("errAcceso").textContent = "";
};
$("btnOlvide").onclick = async () => {
  const correo = $("inCorreo").value.trim();
  if (!correo) { $("errAcceso").textContent = "Escribe tu correo arriba y vuelve a tocar “Olvidé mi contraseña”."; return; }
  try { await sendPasswordResetEmail(auth, correo); toast("Te enviamos un correo para cambiar la contraseña."); }
  catch (e) { $("errAcceso").textContent = traducirError(e); }
};
$("formAcceso").onsubmit = async (ev) => {
  ev.preventDefault();
  const correo = $("inCorreo").value.trim(), clave = $("inClave").value;
  $("btnAcceso").disabled = true; $("errAcceso").textContent = "";
  try {
    if (modoRegistro) {
      const cred = await createUserWithEmailAndPassword(auth, correo, clave);
      await setDoc(doc(db, "users", cred.user.uid), {
        nombre: $("inNombre").value.trim(), email: correo.toLowerCase(), tokens: [], creadoEn: serverTimestamp()
      }, { merge: true });
    } else {
      await signInWithEmailAndPassword(auth, correo, clave);
    }
  } catch (e) { $("errAcceso").textContent = traducirError(e); }
  $("btnAcceso").disabled = false;
};
function traducirError(e) {
  const c = e.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Correo o contraseña incorrectos.";
  if (c.includes("email-already-in-use")) return "Ese correo ya tiene cuenta. Toca “Ya tengo cuenta: entrar”.";
  if (c.includes("weak-password")) return "La contraseña debe tener al menos 6 caracteres.";
  if (c.includes("invalid-email")) return "Revisa que el correo esté bien escrito.";
  if (c.includes("unauthorized-domain")) return "Falta autorizar este dominio en Firebase (Authentication → Configuración → Dominios autorizados).";
  if (c.includes("too-many-requests")) return "Demasiados intentos. Espera unos minutos.";
  return "No se pudo completar: " + (e.message || c);
}
$("btnSalir").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  desuscribir.forEach((f) => f()); desuscribir = [];
  if (!user) {
    yo = null; $("vistaApp").classList.add("oculto"); $("vistaAcceso").classList.remove("oculto"); return;
  }
  esAdmin = (user.email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase();
  const perfil = await getDoc(doc(db, "users", user.uid));
  if (!perfil.exists()) {
    await setDoc(doc(db, "users", user.uid), { nombre: user.email.split("@")[0], email: user.email.toLowerCase(), tokens: [], creadoEn: serverTimestamp() });
  }
  yo = { uid: user.uid, email: user.email, ...(perfil.data() || {}) };
  $("yoNombre").textContent = yo.nombre || user.email;
  $("vistaAcceso").classList.add("oculto"); $("vistaApp").classList.remove("oculto");
  primeraCarga = true;
  escuchar();
  iniciarNotificaciones(false);
  dibujarPestanas(); dibujar();
});

/* ---------- Datos en vivo ---------- */
function redibujarAdmin() {
  if (pestanaActual === "mis") return;
  const f = document.querySelector("#formNuevo, #formGrupo, #formToken");
  const escribiendo = f && [...f.querySelectorAll("input[type=text], input[type=password], input:not([type]), textarea")].some((i) => i.value.trim());
  if (!escribiendo) dibujar();
}
function escuchar() {
  const q = query(collection(db, "comunicados"), where("destinatarios", "array-contains", yo.uid));
  desuscribir.push(onSnapshot(q, (snap) => {
    misComunicados = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.creadoEn?.seconds || 0) - (a.creadoEn?.seconds || 0));
    // Si llega un comunicado nuevo con la app abierta, interrumpe la pantalla
    if (!primeraCarga) {
      for (const ch of snap.docChanges()) {
        if (ch.type === "added" && !(ch.doc.data().confirmados || []).includes(yo.uid)) mostrarInterrupcion(ch.doc.id, false);
      }
    }
    if (primeraCarga) setTimeout(revisarAvisosSinAtender, 800);
    primeraCarga = false;
    if (pestanaActual === "mis") dibujar();
  }));
  if (esAdmin) {
    desuscribir.push(onSnapshot(collection(db, "comunicados"), (snap) => {
      todosComunicados = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.creadoEn?.seconds || 0) - (a.creadoEn?.seconds || 0));
      if (pestanaActual === "enviados") dibujar();
    }));
    desuscribir.push(onSnapshot(collection(db, "users"), (snap) => {
      usuarios = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));
      redibujarAdmin();
    }));
    desuscribir.push(onSnapshot(doc(db, "config", "github"), (d) => {
      ghToken = d.data()?.token || "";
      if (pestanaActual === "equipo") redibujarAdmin();
    }, () => {}));
    desuscribir.push(onSnapshot(collection(db, "grupos"), (snap) => {
      grupos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.nombre.localeCompare(b.nombre));
      redibujarAdmin();
    }));
  }
}

/* ---------- Notificaciones ---------- */
let estadoNotif = "desconocido"; // listo | pendiente | ios-instalar | no-soportado | bloqueado
async function iniciarNotificaciones(pedirPermiso) {
  const soportado = await isSupported().catch(() => false);
  if (!soportado || !("Notification" in window)) {
    estadoNotif = esIOS && !instalada ? "ios-instalar" : "no-soportado"; dibujar(); return;
  }
  if (Notification.permission === "denied") { estadoNotif = "bloqueado"; dibujar(); return; }
  if (Notification.permission !== "granted") {
    if (!pedirPermiso) { estadoNotif = "pendiente"; dibujar(); return; }
    const p = await Notification.requestPermission();
    if (p !== "granted") { estadoNotif = p === "denied" ? "bloqueado" : "pendiente"; dibujar(); return; }
  }
  try {
    const swUrl = "./firebase-messaging-sw.js?config=" + encodeURIComponent(JSON.stringify(firebaseConfig));
    const reg = await navigator.serviceWorker.register(swUrl, { scope: "./" });
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) {
      await setDoc(doc(db, "users", yo.uid), { tokens: arrayUnion(token) }, { merge: true });
      estadoNotif = "listo";
      if (pedirPermiso) toast("Notificaciones activadas en este dispositivo.");
    }
    onMessage(messaging, (payload) => {
      const id = payload.data?.comunicadoId;
      if (id) mostrarInterrupcion(id, true, payload.notification, true);
    });
  } catch (e) {
    console.error(e); estadoNotif = "pendiente";
    if (pedirPermiso) toast("No se pudieron activar: " + (e.message || e));
  }
  dibujar();
}

function bloqueNotificaciones() {
  if (estadoNotif === "listo" || estadoNotif === "desconocido") return "";
  if (estadoNotif === "ios-instalar") return `
    <div class="activar"><div><strong>Para recibir avisos en iPhone, instala la app:</strong>
      <ol><li>Toca el botón Compartir de Safari (el cuadro con la flecha).</li>
      <li>Elige “Agregar a pantalla de inicio”.</li>
      <li>Abre “Avisos” desde tu pantalla de inicio y activa las notificaciones.</li></ol></div></div>`;
  if (estadoNotif === "no-soportado") return `
    <div class="activar"><p>Este navegador no admite notificaciones. Abre esta página en Chrome, Edge o Safari.</p></div>`;
  if (estadoNotif === "bloqueado") return `
    <div class="activar"><p>Bloqueaste las notificaciones para esta app. Actívalas en los ajustes del navegador (el candado junto a la dirección) o del teléfono, y recarga la página.</p></div>`;
  return `<div class="activar"><p><strong>Activa los avisos en este dispositivo</strong> para que te lleguen los recordatorios aunque la app esté cerrada. Hazlo también en tu computadora y en tu celular.</p>
    <button class="btn" data-accion="activar">Activar notificaciones</button></div>`;
}

/* ---------- Interrupción en pantalla ---------- */
let enPantalla = null;
// Reconstruye qué tipo de aviso fue el último enviado (cuando la app se abre después)
function tituloUltimoAviso(c) {
  if (!c?.programa || !c.indiceEnvio) return "";
  const tipo = c.programa[c.indiceEnvio - 1]?.tipo;
  const h = c.eventoEn ? hora(c.eventoEn.toDate()) : "";
  return { antes: `⏰ En 10 minutos: ${c.titulo}`, dia: `⏰ Hoy a las ${h}: ${c.titulo}`, inicio: `⏰ Empieza ahora: ${c.titulo}` }[tipo] || "";
}
function mostrarInterrupcion(id, esRecordatorio, notif, desdePush = false) {
  if (!yo) return;
  const c = misComunicados.find((x) => x.id === id);
  const yaConfirmo = c && (c.confirmados || []).includes(yo.uid);
  // Si ya confirmó, solo se interrumpe por recordatorios del evento que le lleguen
  if (yaConfirmo && !desdePush) return;
  if (enPantalla === id && bucleAlarma) return; // ya está en pantalla y sonando
  enPantalla = id;
  const titulo = notif?.title || tituloUltimoAviso(c);
  $("intTipo").textContent = titulo.startsWith("⏰") ? titulo.split(": ")[0].replace("⏰", "").trim()
    : esRecordatorio && c?.enviosRealizados ? "Recordatorio pendiente" : "Nuevo comunicado";
  $("intTitulo").textContent = c?.titulo || titulo || "Comunicado";
  $("intMensaje").textContent = (c?.eventoEn ? `🗓 ${diaCorto(c.eventoEn.toDate())}, ${hora(c.eventoEn.toDate())}\n` : "") + (c?.mensaje || notif?.body || "");
  $("intConfirmar").textContent = yaConfirmo ? "Entendido" : "Confirmar lectura";
  $("intConfirmar").dataset.confirmado = yaConfirmo ? "1" : "";
  $("interrupcion").classList.remove("oculto");
  $("intConfirmar").focus();
  iniciarAlarma();
}
// Recuerda qué avisos ya se atendieron en este dispositivo (para no repetirlos al abrir la app)
const claveAviso = (c) => `atendido:${c.id}:${c.ultimoEnvio?.seconds || 0}`;
function marcarAtendido(id) {
  const c = misComunicados.find((x) => x.id === id);
  if (c) try { localStorage.setItem(claveAviso(c), "1"); } catch {}
}
function revisarAvisosSinAtender() {
  if (enPantalla) return;
  const ahora = Date.now();
  const reciente = misComunicados.find((c) => {
    if (!c.ultimoEnvio || !c.enviosRealizados) return false;
    if (ahora - c.ultimoEnvio.toMillis() > 45 * 60000) return false;          // solo avisos recientes
    if (c.eventoEn && c.eventoEn.toMillis() + 15 * 60000 < ahora) return false; // evento ya pasó
    const confirmo = (c.confirmados || []).includes(yo.uid);
    if (confirmo && !(c.tipo === "evento" && c.recordarATodos)) return false;
    try { return !localStorage.getItem(claveAviso(c)); } catch { return true; }
  });
  if (reciente) mostrarInterrupcion(reciente.id, true, null, true);
}
function cerrarInterrupcion() { if (enPantalla) marcarAtendido(enPantalla); $("interrupcion").classList.add("oculto"); enPantalla = null; detenerAlarma(); }
$("intCerrar").onclick = cerrarInterrupcion;
$("intConfirmar").onclick = async () => {
  const id = enPantalla, yaConfirmo = $("intConfirmar").dataset.confirmado;
  cerrarInterrupcion();
  if (id && !yaConfirmo) await confirmar(id);
};

async function confirmar(id) {
  try {
    await updateDoc(doc(db, "comunicados", id), {
      confirmados: arrayUnion(yo.uid), [`confirmadosEn.${yo.uid}`]: serverTimestamp()
    });
    toast("Lectura confirmada. Ya no recibirás recordatorios de este comunicado.");
  } catch (e) { toast("No se pudo confirmar: " + e.message); }
}

/* ---------- Pestañas ---------- */
function dibujarPestanas() {
  const tabs = [["mis", "Mis comunicados"]];
  if (esAdmin) tabs.push(["nuevo", "Nuevo comunicado"], ["enviados", "Enviados"], ["equipo", "Equipo y grupos"]);
  $("pestanas").innerHTML = tabs.map(([k, t]) =>
    `<button role="tab" data-tab="${k}" aria-selected="${k === pestanaActual}">${t}</button>`).join("");
}
$("pestanas").onclick = (e) => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  pestanaActual = b.dataset.tab; dibujarPestanas(); dibujar(); scrollTo(0, 0);
};

function dibujar() {
  if (!yo) return;
  const vistas = { mis: vistaMis, nuevo: vistaNuevo, enviados: vistaEnviados, equipo: vistaEquipo };
  $("contenido").innerHTML = (vistas[pestanaActual] || vistaMis)();
  if (pestanaActual === "nuevo") prepararNuevo();
  if (destacar) {
    const el = document.querySelector(`[data-id="${destacar}"]`);
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("resaltado"); destacar = null; history.replaceState(null, "", location.pathname); }
  }
}

/* ---------- Vista: Mis comunicados ---------- */
function vistaMis() {
  const pend = misComunicados.filter((c) => !(c.confirmados || []).includes(yo.uid));
  const leid = misComunicados.filter((c) => (c.confirmados || []).includes(yo.uid));
  const tarjeta = (c, pendiente) => `
    <article class="aviso ${pendiente ? "pendiente" : ""}" data-id="${c.id}">
      <h3>${esc(c.titulo)}</h3>
      ${c.eventoEn ? `<p style="margin:0 0 8px;font-weight:700">🗓 ${esc(diaCorto(c.eventoEn.toDate()))}, ${esc(hora(c.eventoEn.toDate()))}</p>` : ""}
      <p class="cuerpo">${esc(c.mensaje)}</p>
      <div class="meta">Enviado ${fecha(c.creadoEn)}</div>
      <div class="acciones">${pendiente
        ? `<button class="btn si" data-accion="confirmar" data-id="${c.id}">Confirmar lectura</button>`
        : `<span class="estado ok">Confirmado</span>`}</div>
    </article>`;
  return `${bloqueNotificaciones()}
    <h1 class="titulo">Hola, ${esc((yo.nombre || "").split(" ")[0])}</h1>
    <p class="sub">${pend.length ? `Tienes ${pend.length} ${pend.length === 1 ? "comunicado pendiente" : "comunicados pendientes"} de confirmar.` : "Estás al día con todos tus comunicados."}</p>
    ${pend.map((c) => tarjeta(c, true)).join("")}
    ${leid.length ? `<div class="seccion"><h2>Ya confirmados</h2>${leid.map((c) => tarjeta(c, false)).join("")}</div>` : ""}
    ${!misComunicados.length ? `<div class="vacio">Aquí aparecerán los comunicados que te envíen.</div>` : ""}`;
}

/* ---------- Vista: Nuevo comunicado ---------- */
let seleccion = new Set();

// Calcula cuándo se envía cada aviso de un evento:
// al crearlo, el día del evento desde las 8:45 cada 30 min, y 10 minutos antes.
function calcularPrograma(evento, ahora = new Date()) {
  const programa = [{ en: ahora, tipo: "inicial" }];
  const diezAntes = new Date(evento.getTime() - 10 * 60000);
  const inicio = new Date(evento); inicio.setHours(8, 45, 0, 0);
  for (let t = inicio; t < diezAntes; t = new Date(t.getTime() + 30 * 60000)) {
    if (t - ahora < 2 * 60000) continue;        // ya pasó o es casi ahora
    if (diezAntes - t < 5 * 60000) continue;    // muy pegado al aviso de 10 min
    programa.push({ en: t, tipo: "dia" });
  }
  if (diezAntes - ahora > 2 * 60000) programa.push({ en: diezAntes, tipo: "antes" });
  if (evento - ahora > 2 * 60000) programa.push({ en: evento, tipo: "inicio" });
  return programa;
}
const hora = (d) => d.toLocaleTimeString("es", { hour: "numeric", minute: "2-digit" });
const diaCorto = (d) => d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });

function vistaNuevo() {
  const ahora = new Date(), manana = new Date(Date.now() + 24 * 3600e3);
  const eventoDef = new Date(manana); eventoDef.setHours(10, 0, 0, 0);
  return `<h1 class="titulo">Nuevo comunicado</h1>
    <p class="sub">Elige a quién va y cuándo se le recuerda.</p>
    <form class="panel" id="formNuevo">
      <label class="campo"><span>Título</span><input id="nTitulo" required maxlength="80" placeholder="Ej.: Reunión general"></label>
      <label class="campo"><span>Mensaje</span><textarea id="nMensaje" required maxlength="1500"></textarea></label>
      <fieldset><legend>Destinatarios</legend>
        <div class="chips">
          <button type="button" class="chip" data-grupo="*">Todo el equipo</button>
          ${grupos.map((g) => `<button type="button" class="chip" data-grupo="${g.id}">${esc(g.nombre)}</button>`).join("")}
          <button type="button" class="chip" data-grupo="-">Quitar todos</button>
        </div>
        <div class="personas">${usuarios.map((u) => `
          <label class="persona"><input type="checkbox" value="${u.id}" ${seleccion.has(u.id) ? "checked" : ""}>
            <div>${esc(u.nombre)}<small>${esc(u.email)}${(u.tokens || []).length ? "" : " · sin notificaciones activas"}</small></div></label>`).join("")
          || `<div class="vacio">Aún no hay personas registradas. Comparte el enlace de la app con tu equipo.</div>`}</div>
        <p class="nota" id="nCuenta"></p>
      </fieldset>

      <fieldset><legend>Tipo de comunicado</legend>
        <div class="radios">
          <label><input type="radio" name="tipo" value="evento" checked> Evento con fecha y hora</label>
          <label><input type="radio" name="tipo" value="aviso"> Aviso general</label>
        </div>
      </fieldset>

      <div id="bloqueEvento">
        <label class="campo"><span>Fecha y hora del evento</span><input type="datetime-local" id="nEvento" value="${aLocal(eventoDef)}"></label>
        <label class="persona" style="padding:0 0 14px;border:0"><input type="checkbox" id="nATodos" checked>
          <div>Recordar el evento también a quien ya confirmó la lectura</div></label>
        <div class="aviso" style="background:var(--aviso-claro);border:0;margin-bottom:18px"><div id="nPrograma" class="nota" style="color:var(--tinta)"></div></div>
      </div>

      <div id="bloqueAviso" class="oculto">
        <fieldset><legend>Cuándo enviarlo</legend>
          <div class="radios">
            <label><input type="radio" name="cuando" value="ya" checked> Ahora</label>
            <label><input type="radio" name="cuando" value="prog"> Programar</label>
          </div>
          <label class="campo oculto" id="campoFecha" style="margin-top:12px"><span>Fecha y hora</span><input type="datetime-local" id="nFecha" value="${aLocal(ahora)}"></label>
        </fieldset>
        <div class="fila">
          <label class="campo"><span>Recordar a quien no confirme</span>
            <select id="nRepetir">
              <option value="0">No enviar recordatorios</option>
              <option value="30">Cada 30 minutos</option>
              <option value="60" selected>Cada hora</option>
              <option value="120">Cada 2 horas</option>
              <option value="240">Cada 4 horas</option>
              <option value="1440">Una vez al día</option>
            </select></label>
          <label class="campo" id="campoHasta"><span>Dejar de recordar el</span><input type="datetime-local" id="nHasta" value="${aLocal(manana)}"></label>
        </div>
      </div>

      <p class="nota">${ghToken ? "El primer aviso llega en menos de un minuto." : "El primer aviso puede tardar hasta 5–10 minutos. Activa el envío inmediato en “Equipo y grupos”."} Quien tenga la app abierta lo ve al instante.</p>
      <button class="btn grande" id="btnEnviar">Enviar comunicado</button>
    </form>`;
}

function prepararNuevo() {
  const f = $("formNuevo");
  const actualizar = () => {
    f.querySelectorAll(".persona input[value]").forEach((i) => (i.checked = seleccion.has(i.value)));
    $("nCuenta").textContent = seleccion.size ? `${seleccion.size} ${seleccion.size === 1 ? "persona seleccionada" : "personas seleccionadas"}` : "Nadie seleccionado todavía.";
  };
  const vistaPrograma = () => {
    const ev = new Date($("nEvento").value);
    if (isNaN(ev) || ev <= new Date()) { $("nPrograma").textContent = "Elige una fecha y hora futuras para el evento."; return; }
    const p = calcularPrograma(ev);
    const dia = p.filter((x) => x.tipo === "dia");
    const antes = p.find((x) => x.tipo === "antes");
    const empieza = p.find((x) => x.tipo === "inicio");
    $("nPrograma").innerHTML = `<strong>Se enviarán ${p.length} avisos:</strong>
      <ul class="lista-nombres">
        <li>Ahora, al enviar el comunicado</li>
        ${dia.length ? `<li>El ${diaCorto(ev)}: ${dia.length === 1 ? `a las ${hora(dia[0].en)}` : `de ${hora(dia[0].en)} a ${hora(dia.at(-1).en)}, cada 30 minutos`}</li>` : ""}
        ${antes ? `<li>A las ${hora(antes.en)}, 10 minutos antes del evento</li>` : ""}
        ${empieza ? `<li>A las ${hora(empieza.en)}, cuando empieza el evento</li>` : ""}
      </ul>`;
  };
  actualizar(); vistaPrograma();
  f.querySelectorAll(".persona input[value]").forEach((i) => i.onchange = () => { i.checked ? seleccion.add(i.value) : seleccion.delete(i.value); actualizar(); });
  f.querySelectorAll("[data-grupo]").forEach((b) => b.onclick = () => {
    const g = b.dataset.grupo;
    if (g === "*") usuarios.forEach((u) => seleccion.add(u.id));
    else if (g === "-") seleccion.clear();
    else (grupos.find((x) => x.id === g)?.miembros || []).forEach((m) => usuarios.some((u) => u.id === m) && seleccion.add(m));
    actualizar();
  });
  f.querySelectorAll("input[name=tipo]").forEach((r) => r.onchange = () => {
    $("bloqueEvento").classList.toggle("oculto", f.tipo.value !== "evento");
    $("bloqueAviso").classList.toggle("oculto", f.tipo.value !== "aviso");
  });
  $("nEvento").oninput = vistaPrograma;
  f.querySelectorAll("input[name=cuando]").forEach((r) => r.onchange = () => $("campoFecha").classList.toggle("oculto", f.cuando.value !== "prog"));
  $("nRepetir").onchange = () => $("campoHasta").classList.toggle("oculto", $("nRepetir").value === "0");

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!seleccion.size) { toast("Elige al menos un destinatario."); return; }
    const ahora = new Date();
    const base = {
      titulo: $("nTitulo").value.trim(), mensaje: $("nMensaje").value.trim(),
      destinatarios: [...seleccion], confirmados: [], confirmadosEn: {},
      creadoEn: serverTimestamp(), activo: true, enviosRealizados: 0,
      zonaHoraria: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    let datos, inmediato;
    if (f.tipo.value === "evento") {
      const evento = new Date($("nEvento").value);
      if (isNaN(evento) || evento <= ahora) { toast("La fecha del evento debe ser futura."); return; }
      const programa = calcularPrograma(evento, ahora);
      datos = { ...base, tipo: "evento", eventoEn: Timestamp.fromDate(evento),
        programa: programa.map((p) => ({ en: Timestamp.fromDate(p.en), tipo: p.tipo })),
        indiceEnvio: 0, proximoEnvio: Timestamp.fromDate(ahora), recordarATodos: $("nATodos").checked,
        enviarEn: Timestamp.fromDate(ahora), hasta: Timestamp.fromDate(evento), repetirCadaMin: 0 };
      inmediato = true;
    } else {
      const enviarEn = f.cuando.value === "prog" ? new Date($("nFecha").value) : ahora;
      const repetir = Number($("nRepetir").value);
      const hasta = repetir ? new Date($("nHasta").value) : enviarEn;
      if (repetir && hasta <= enviarEn) { toast("La fecha para dejar de recordar debe ser posterior al envío."); return; }
      datos = { ...base, tipo: "aviso", enviarEn: Timestamp.fromDate(enviarEn), proximoEnvio: Timestamp.fromDate(enviarEn),
        repetirCadaMin: repetir, hasta: Timestamp.fromDate(hasta) };
      inmediato = f.cuando.value !== "prog";
    }
    $("btnEnviar").disabled = true;
    try {
      await addDoc(collection(db, "comunicados"), datos);
      seleccion.clear();
      const r = inmediato ? await dispararEnvio() : "programado";
      toast(r === "ok" ? "Comunicado enviado. Llegará en menos de un minuto."
        : r === "programado" ? "Comunicado programado."
        : r === "sin-token" ? "Comunicado guardado. Llegará en los próximos minutos."
        : "Comunicado guardado, pero el envío inmediato falló (revisa el token). Llegará en unos minutos.");
      pestanaActual = "enviados"; dibujarPestanas(); dibujar();
    } catch (e) { toast("No se pudo guardar: " + e.message); $("btnEnviar").disabled = false; }
  };
}

// Pide a GitHub que ejecute el envío en este momento, sin esperar al turno de 5 minutos
async function dispararEnvio() {
  if (!ghToken) return "sin-token";
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/recordatorios.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ ref: "main" })
    });
    return r.status === 204 ? "ok" : "error";
  } catch { return "error"; }
}

/* ---------- Vista: Enviados ---------- */
function vistaEnviados() {
  if (!todosComunicados.length) return `<h1 class="titulo">Enviados</h1><div class="vacio">Todavía no has enviado comunicados.</div>`;
  return `<h1 class="titulo">Enviados</h1><p class="sub">Revisa quién ya confirmó y quién sigue recibiendo recordatorios.</p>` +
    todosComunicados.map((c) => {
      const conf = c.confirmados || [], dest = c.destinatarios || [];
      const pend = dest.filter((u) => !conf.includes(u));
      const estado = !c.activo ? `<span class="estado fin">Finalizado</span>`
        : c.tipo === "evento" ? `<span class="estado esp">Próximo aviso: ${fecha(c.proximoEnvio)}</span>`
        : c.enviosRealizados ? `<span class="estado esp">Recordando cada ${etiquetaIntervalo(c.repetirCadaMin)}</span>`
        : `<span class="estado esp">Programado: ${fecha(c.enviarEn)}</span>`;
      return `<article class="aviso">
        <h3>${esc(c.titulo)}</h3>
        ${c.eventoEn ? `<p style="margin:0 0 8px;font-weight:700">🗓 Evento: ${fecha(c.eventoEn)}</p>` : ""}
        <div class="acciones" style="margin-top:0">${estado}<span class="estado ${pend.length ? "esp" : "ok"}">${conf.length} de ${dest.length} confirmaron</span></div>
        <p class="meta">Creado ${fecha(c.creadoEn)}${c.ultimoEnvio ? ` · último envío ${fecha(c.ultimoEnvio)}` : ""}</p>
        <details><summary>Ver detalle</summary>
          <p class="cuerpo" style="margin-top:10px">${esc(c.mensaje)}</p>
          ${pend.length ? `<strong>Pendientes</strong><ul class="lista-nombres">${pend.map((u) => `<li>${esc(nombreDe(u))}</li>`).join("")}</ul>` : ""}
          ${conf.length ? `<strong>Confirmaron</strong><ul class="lista-nombres">${conf.map((u) => `<li>${esc(nombreDe(u))}${c.confirmadosEn?.[u] ? ` — ${fecha(c.confirmadosEn[u])}` : ""}</li>`).join("")}</ul>` : ""}
        </details>
        <div class="acciones">
          ${c.activo ? `<button class="btn claro" data-accion="detener" data-id="${c.id}">Detener recordatorios</button>` : ""}
          <button class="btn peligro" data-accion="eliminar" data-id="${c.id}">Eliminar</button>
        </div></article>`;
    }).join("");
}
const etiquetaIntervalo = (m) => ({ 30: "30 min", 60: "hora", 120: "2 horas", 240: "4 horas", 1440: "día" }[m] || `${m} min`);

/* ---------- Vista: Equipo y grupos ---------- */
function vistaEquipo() {
  return `<h1 class="titulo">Equipo y grupos</h1>
    <p class="sub">Comparte este enlace con tu equipo para que creen su cuenta:<br><strong>${esc(location.origin + location.pathname)}</strong></p>
    <button class="btn claro" data-accion="copiar">Copiar enlace</button>
    <div class="seccion"><h2>Personas (${usuarios.length})</h2>
      <div class="panel" style="padding:0">${usuarios.map((u) => `
        <div class="persona" style="cursor:default"><div style="flex:1">${esc(u.nombre)}<small>${esc(u.email)}</small></div>
        <span class="estado ${(u.tokens || []).length ? "ok" : "esp"}">${(u.tokens || []).length ? `${u.tokens.length} ${u.tokens.length === 1 ? "dispositivo" : "dispositivos"}` : "Sin notificaciones"}</span></div>`).join("")
        || `<div class="vacio">Nadie se ha registrado aún.</div>`}</div></div>
    <div class="seccion"><h2>Envío inmediato</h2>
      <form class="panel" id="formToken">
        <p style="margin-top:0">${ghToken
          ? "<strong>Activado.</strong> Los comunicados salen en menos de un minuto. Si cambias el token, pega el nuevo abajo."
          : "Sin activar: los comunicados tardan hasta 5–10 minutos en salir. Pega aquí tu token de GitHub para que salgan al instante."}</p>
        <label class="campo"><span>Token de GitHub</span><input id="tToken" type="password" autocomplete="off" placeholder="github_pat_…" required></label>
        <div class="acciones"><button class="btn">Guardar token</button>
        ${ghToken ? `<button type="button" class="btn claro" data-accion="probarToken">Probar envío ahora</button>` : ""}</div>
      </form></div>
    <div class="seccion"><h2>Grupos</h2>
      ${grupos.map((g) => `<article class="aviso"><h3>${esc(g.nombre)}</h3>
        <p class="meta">${(g.miembros || []).map((m) => esc(nombreDe(m))).join(", ") || "Sin integrantes"}</p>
        <div class="acciones"><button class="btn peligro" data-accion="borrarGrupo" data-id="${g.id}">Eliminar grupo</button></div></article>`).join("")}
      <form class="panel" id="formGrupo">
        <label class="campo"><span>Nombre del grupo nuevo</span><input id="gNombre" required placeholder="Ej.: Turno mañana"></label>
        <div class="personas" style="margin-bottom:16px">${usuarios.map((u) => `
          <label class="persona"><input type="checkbox" value="${u.id}"><div>${esc(u.nombre)}<small>${esc(u.email)}</small></div></label>`).join("")}</div>
        <button class="btn">Crear grupo</button>
      </form></div>`;
}

/* ---------- Acciones (clics) ---------- */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-accion]"); if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.accion) {
    case "activar": iniciarNotificaciones(true); break;
    case "probarToken": toast((await dispararEnvio()) === "ok" ? "Listo: GitHub está ejecutando el envío." : "El token no funcionó. Revisa que tenga permiso de Actions (lectura y escritura) en este repositorio."); break;
    case "confirmar": b.disabled = true; await confirmar(id); break;
    case "detener": await updateDoc(doc(db, "comunicados", id), { activo: false, motivoFin: "detenido por el administrador" }); toast("Recordatorios detenidos."); break;
    case "eliminar": if (confirm("¿Eliminar este comunicado? Desaparecerá también para tu equipo.")) { await deleteDoc(doc(db, "comunicados", id)); toast("Comunicado eliminado."); } break;
    case "borrarGrupo": if (confirm("¿Eliminar este grupo? Las personas no se borran.")) { await deleteDoc(doc(db, "grupos", id)); toast("Grupo eliminado."); } break;
    case "copiar": try { await navigator.clipboard.writeText(location.origin + location.pathname); toast("Enlace copiado."); } catch { toast("Copia el enlace manualmente."); } break;
  }
});
document.addEventListener("submit", async (e) => {
  if (e.target.id === "formToken") {
    e.preventDefault();
    const t = $("tToken").value.trim();
    try { await setDoc(doc(db, "config", "github"), { token: t, actualizado: serverTimestamp() }); e.target.reset(); toast("Token guardado."); dibujar(); }
    catch (err) { toast("No se pudo guardar: revisa que pegaste las reglas nuevas en Firebase."); }
    return;
  }
  if (e.target.id !== "formGrupo") return;
  e.preventDefault();
  const miembros = [...e.target.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
  await addDoc(collection(db, "grupos"), { nombre: $("gNombre").value.trim(), miembros, creadoEn: serverTimestamp() });
  e.target.reset(); toast("Grupo creado."); dibujar();
});

// Al volver a la app, revisa si hay algún comunicado pendiente abierto desde una notificación
if (abiertoDesdeAviso) {
  const intento = setInterval(() => {
    const c = misComunicados.find((x) => x.id === abiertoDesdeAviso);
    if (c) { clearInterval(intento); if (!(c.confirmados || []).includes(yo?.uid)) mostrarInterrupcion(c.id, true); }
  }, 500);
  setTimeout(() => clearInterval(intento), 15000);
}
