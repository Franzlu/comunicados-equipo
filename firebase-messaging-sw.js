// Service worker: recibe las notificaciones aunque la app esté cerrada.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// La configuración llega en la URL de registro (así solo se edita en config.js)
const params = new URL(self.location).searchParams;
const config = JSON.parse(params.get('config') || '{}');
firebase.initializeApp(config);
const messaging = firebase.messaging();

// Firebase muestra las notificaciones automáticamente y, al tocarlas,
// abre la app en el comunicado correspondiente.
