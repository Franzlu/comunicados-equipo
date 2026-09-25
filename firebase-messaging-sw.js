// Service worker: recibe las notificaciones aunque la app esté cerrada.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Activar esta versión de inmediato al actualizar
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// La configuración llega en la URL de registro (así solo se edita en config.js)
const params = new URL(self.location).searchParams;
const config = JSON.parse(params.get('config') || '{}');
firebase.initializeApp(config);
const messaging = firebase.messaging();
// Firebase muestra la notificación y, al tocarla, abre la app en el comunicado.

async function avisarVentanas(mensaje) {
  const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  ventanas.forEach((v) => v.postMessage(mensaje));
}

// Si la app está abierta (aunque esté minimizada o detrás de otro programa),
// se le avisa para que muestre la pantalla amarilla y haga sonar la alarma.
self.addEventListener('push', (event) => {
  let datos = {};
  try { datos = event.data?.json() || {}; } catch {}
  const id = datos.data?.comunicadoId;
  if (!id) return;
  event.waitUntil(avisarVentanas({
    tipo: 'aviso-push', comunicadoId: id,
    title: datos.notification?.title, body: datos.notification?.body
  }));
});

// Si cierran la notificación de Windows, la alarma deja de sonar
self.addEventListener('notificationclose', (event) => {
  const id = event.notification?.tag;
  if (id) event.waitUntil(avisarVentanas({ tipo: 'aviso-cerrado', comunicadoId: id }));
});
