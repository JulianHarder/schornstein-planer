// Wird im <head> geladen, damit der gewählte Modus ohne Aufblitzen gesetzt wird.
// Gespeichert wird nur, wenn der Nutzer den Umschalter aktiv bedient hat.
(function () {
  try {
    var t = localStorage.getItem('schornstein-planer-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* Speicher nicht verfügbar: Systemeinstellung gilt */ }
})();
