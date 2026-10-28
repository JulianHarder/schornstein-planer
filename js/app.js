/* Schornstein-Planer
 * Läuft komplett lokal (index.html per Doppelklick öffnen). Keine Module, kein Server,
 * keine externen Ressourcen. Daten liegen im localStorage dieses Browsers.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'schornstein-planer-daten-v1';
  var THEME_KEY = 'schornstein-planer-theme';

  var STATUS = [
    { key: 'planung', label: 'In Planung' },
    { key: 'bearbeitung', label: 'In Bearbeitung' },
    { key: 'abgeschlossen', label: 'Abgeschlossen' }
  ];
  var MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  var MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  var WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  var STRASSEN_STANDARD = [{ name: 'Stahl' }, { name: 'Edelstahl' }, { name: 'Keramik' }];

  /* ---------- Hilfsfunktionen ---------- */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromISO(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(iso, n) { var d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
  function diffDays(a, b) { return Math.round((fromISO(b) - fromISO(a)) / 864e5); }
  function todayISO() { return toISO(new Date()); }
  function fmt(iso) { return fromISO(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  function isoDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : ''; }
  /* Einstellungen für die ganze Mappe. sa/so sagen, ob Samstag bzw. Sonntag als
     Arbeitstag zählt. Zählen beide, ist das Ergebnis identisch zur reinen
     Kalendertagsrechnung – deshalb braucht es dafür keinen Sonderfall. */
  var einst = { sa: true, so: true };

  var WOCHENMODI = [
    { key: 'mo-so', label: 'Mo\u2013So', sa: true, so: true },
    { key: 'mo-sa', label: 'Mo\u2013Sa', sa: true, so: false },
    { key: 'mo-fr-so', label: 'Mo\u2013Fr + So', sa: false, so: true },
    { key: 'mo-fr', label: 'Mo\u2013Fr', sa: false, so: false }
  ];

  function wochenmodus() {
    return WOCHENMODI.filter(function (m) { return m.sa === einst.sa && m.so === einst.so; })[0] || WOCHENMODI[0];
  }

  function alleTageZaehlen() { return einst.sa && einst.so; }

  function tage(n) {
    if (alleTageZaehlen()) return n + (n === 1 ? ' Tag' : ' Tage');
    return n + (n === 1 ? ' Arbeitstag' : ' Arbeitstage');
  }

  function istArbeitstag(iso) {
    var t = fromISO(iso).getDay();
    if (t === 6) return einst.sa;
    if (t === 0) return einst.so;
    return true;
  }

  function naechsterArbeitstag(iso) {
    for (var i = 0; i < 7 && !istArbeitstag(iso); i++) iso = addDays(iso, 1);
    return iso;
  }

  // Enddatum nach n Arbeitstagen; der Starttag zählt als erster
  function endeNachArbeitstagen(start, n) {
    var iso = naechsterArbeitstag(start);
    for (var rest = n - 1; rest > 0; rest--) iso = naechsterArbeitstag(addDays(iso, 1));
    return iso;
  }

  // Spalten des Kalenderrasters: Mo-Fr immer, Sa und So je nach Einstellung
  function sichtbareSpalten() {
    var out = [0, 1, 2, 3, 4];
    if (einst.sa) out.push(5);
    if (einst.so) out.push(6);
    return out;
  }

  // Kalenderwoche nach ISO 8601 (Woche 1 ist die mit dem 4. Januar)
  function isoWeek(iso) {
    var t = fromISO(iso);
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);
    var ft = new Date(t.getFullYear(), 0, 4);
    ft.setDate(ft.getDate() - ((ft.getDay() + 6) % 7) + 3);
    return 1 + Math.round((t - ft) / 6048e5);
  }

  function statusLabel(key) {
    var s = STATUS.filter(function (x) { return x.key === key; })[0];
    return s ? s.label : key;
  }

  /* ---------- Fertigungsstraßen ---------- */

  var strassen = [];

  function normalizeStrasse(s) {
    return { id: String(s.id || uid()), name: String(s.name || 'Fertigungsstraße').slice(0, 60) };
  }

  /* ---------- Daten ---------- */

  var projects = [];

  /* Status aus den Terminen: vor dem Start "In Planung", zwischen Start und Ende
     "In Bearbeitung", danach "Abgeschlossen". Wer den Status selbst setzt (im
     Dialog oder per Kanban-Zug), schaltet die Automatik für dieses Projekt ab. */
  function autoStatusVon(p) {
    if (!p.start) return 'planung';
    var t = todayISO();
    if (t < startOf(p)) return 'planung';
    if (t > endOf(p)) return 'abgeschlossen';
    return 'bearbeitung';
  }

  function aktualisiereStatus() {
    var geaendert = false;
    projects.forEach(function (p) {
      if (!p.autoStatus || p.archived) return;
      var neu = autoStatusVon(p);
      if (p.status !== neu) { p.status = neu; geaendert = true; }
    });
    return geaendert;
  }

  function normalize(p) {
    var status = STATUS.some(function (s) { return s.key === p.status; }) ? p.status : 'planung';
    var dauer = {};
    if (p.dauer && typeof p.dauer === 'object') {
      strassen.forEach(function (s) {
        var n = parseInt(p.dauer[s.id], 10);
        if (n > 0) dauer[s.id] = n;
      });
    } else {
      // Altbestand (Version 1): eine einzelne Dauer → erste Fertigungsstraße
      var alt = parseInt(p.dauer, 10);
      if (alt > 0 && strassen.length) dauer[strassen[0].id] = alt;
    }
    if (!Object.keys(dauer).length && strassen.length) dauer[strassen[0].id] = 1;
    var fertig = {
      id: String(p.id || uid()),
      name: String(p.name || 'Unbenannt'),
      kunde: String(p.kunde || ''),
      ort: String(p.ort || ''),
      status: status,
      start: isoDate(p.start),
      dauer: dauer,
      parallel: !!p.parallel,
      liefertermin: isoDate(p.liefertermin),
      notiz: String(p.notiz || ''),
      autoStatus: p.autoStatus !== false,
      created: p.created || new Date().toISOString(),
      archived: !!p.archived
    };
    if (fertig.autoStatus && !fertig.archived) fertig.status = autoStatusVon(fertig);
    return fertig;
  }

  function seed() {
    var t = todayISO();
    var now = Date.now();
    var a = strassen[0].id;
    var b = strassen[1] ? strassen[1].id : a;
    var c = strassen[2] ? strassen[2].id : a;
    function created(daysAgo) { return new Date(now - daysAgo * 864e5).toISOString(); }
    var d1 = {}; d1[b] = 4;
    var d2 = {}; d2[a] = 3; d2[b] = 5;
    var d3 = {}; d3[a] = 4; d3[c] = 3;
    var d4 = {}; d4[c] = 2;
    return [
      { name: 'Edelstahlschornstein Einfamilienhaus', kunde: 'Familie Beispiel', ort: 'Musterstadt', status: 'bearbeitung',
        start: addDays(t, -2), dauer: d1, liefertermin: addDays(t, 6), created: created(18) },
      { name: 'Sanierung Hotelkamin', kunde: 'Hotel Beispielhof', ort: 'Beispieldorf', status: 'planung',
        start: addDays(t, 24), dauer: d2, liefertermin: addDays(t, 34), created: created(6) },
      { name: 'Neubau Gewerbehalle', kunde: 'Muster GmbH', ort: 'Testhausen', status: 'planung',
        start: '', dauer: d3, liefertermin: '', created: created(2) },
      { name: 'Kaminkopf erneuern', kunde: 'Herr Test', ort: 'Probenheim', status: 'abgeschlossen',
        start: addDays(t, -14), dauer: d4, liefertermin: addDays(t, -10), created: created(45) }
    ].map(normalize);
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (Array.isArray(data.projects)) {
          var str = (Array.isArray(data.strassen) && data.strassen.length) ? data.strassen : STRASSEN_STANDARD;
          strassen = str.map(normalizeStrasse);
          leseEinstellungen(data.einstellungen);
          projects = data.projects.map(normalize);
          return;
        }
      }
    } catch (e) { /* defekt oder nicht verfügbar → Demo-Daten */ }
    strassen = STRASSEN_STANDARD.map(normalizeStrasse);
    projects = seed();
  }

  var storageWarned = false;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, einstellungen: { sa: einst.sa, so: einst.so }, strassen: strassen, projects: projects }));
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        alert('Der Browser-Speicher ist nicht verfügbar. Änderungen gehen beim Schließen verloren – bitte regelmäßig "Daten exportieren" nutzen.');
      }
    }
  }

  // ohneWE stammt aus einer früheren Fassung und meinte "weder Sa noch So"
  function leseEinstellungen(e) {
    if (!e) return;
    if (typeof e.sa === 'boolean' || typeof e.so === 'boolean') {
      einst.sa = e.sa !== false;
      einst.so = e.so !== false;
    } else if (e.ohneWE) {
      einst.sa = false;
      einst.so = false;
    }
  }

  function find(id) { return projects.filter(function (p) { return p.id === id; })[0]; }

  /* ---------- Terminberechnung (zur Laufzeit) ---------- */

  // Je beteiligte Fertigungsstraße ein Abschnitt. Standard: nacheinander in der
  // Reihenfolge der Straßenliste. Mit p.parallel starten alle am selben Tag.
  function segments(p) {
    if (!p.start) return [];
    var out = [], cursor = p.start;
    strassen.forEach(function (s) {
      var n = p.dauer[s.id] || 0;
      if (!n) return;
      var start = naechsterArbeitstag(p.parallel ? p.start : cursor);
      var end = endeNachArbeitstagen(start, n);
      if (!p.parallel) cursor = addDays(end, 1);
      out.push({ strasse: s.id, name: s.name, start: start, end: end, tage: n });
    });
    return out;
  }

  function dauerListe(p) {
    return strassen.map(function (s) { return p.dauer[s.id] || 0; }).filter(function (n) { return n > 0; });
  }

  function totalDauer(p) {
    var list = dauerListe(p);
    if (!list.length) return 1;
    return p.parallel
      ? Math.max.apply(null, list)
      : list.reduce(function (a, b) { return a + b; }, 0);
  }

  function startOf(p) {
    return p.start ? naechsterArbeitstag(p.start) : p.start;
  }

  function endOf(p) {
    var segs = segments(p);
    if (!segs.length) return startOf(p);
    return segs.reduce(function (letztes, s) { return s.end > letztes ? s.end : letztes; }, segs[0].end);
  }

  function lieferTooEarly(p) {
    return !!(p.liefertermin && p.start && p.status !== 'abgeschlossen' && p.liefertermin < endOf(p));
  }

  /* ---------- UI-Zustand ---------- */

  var ui = {
    sort: 'created-desc',
    q: '',
    cal: { y: new Date().getFullYear(), m: new Date().getMonth(), mode: 'monat' }
  };
  var drag = null; // { id, day, kind }

  var view = $('#view');
  var dialog = $('#projectDialog');

  /* ---------- Teil-Templates ---------- */

  function scheduleText(p) {
    if (!p.start) return 'Noch nicht eingeplant';
    return fmt(startOf(p)) + ' – ' + fmt(endOf(p)) + ' (' + tage(totalDauer(p)) + ')';
  }

  function strassenText(p) {
    var parts = strassen.filter(function (s) { return p.dauer[s.id] > 0; })
      .map(function (s) { return s.name + ' ' + p.dauer[s.id] + 'T'; });
    if (!parts.length) return '';
    return parts.join(' · ') + (p.parallel ? ' (parallel)' : '');
  }

  function lieferText(p) {
    if (!p.liefertermin) return '';
    var warn = lieferTooEarly(p);
    return '<span class="' + (warn ? 'hint-warn' : '') + '">' +
      (warn ? '⚠ ' : '◆ ') + 'Liefertermin ' + fmt(p.liefertermin) + '</span>';
  }

  function badge(status) {
    return '<span class="badge st-' + esc(status) + '">' + esc(statusLabel(status)) + '</span>';
  }

  function projectCard(p) {
    var actions = p.archived
      ? '<button type="button" class="btn btn-sm" data-action="show" data-id="' + esc(p.id) + '">Öffnen</button>' +
        '<button type="button" class="btn btn-sm" data-action="restore" data-id="' + esc(p.id) + '">Wiederherstellen</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-action="delete" data-id="' + esc(p.id) + '">Löschen</button>'
      : '<button type="button" class="btn btn-sm" data-action="show" data-id="' + esc(p.id) + '">\u00d6ffnen</button>' +
        '<button type="button" class="btn btn-sm" data-action="archive" data-id="' + esc(p.id) + '">Archivieren</button>';
    return '<article class="project-card" data-status="' + esc(p.status) + '">' +
      '<div><h2>' + esc(p.name) + '</h2>' +
      '<div class="project-meta">' +
        (p.kunde ? '<span>' + esc(p.kunde) + '</span>' : '') +
        (p.ort ? '<span>' + esc(p.ort) + '</span>' : '') +
        '<span>' + esc(scheduleText(p)) + '</span>' +
      '</div>' +
      '<div class="project-meta">' +
        (strassenText(p) ? '<span>' + esc(strassenText(p)) + '</span>' : '') +
        (p.liefertermin ? '<span>' + lieferText(p) + '</span>' : '') +
      '</div></div>' +
      '<div class="project-actions">' + badge(p.status) + actions + '</div>' +
    '</article>';
  }

  function miniCard(p) {
    return '<div class="kcard st-' + esc(p.status) + '" draggable="true" data-drag-id="' + esc(p.id) + '" data-action="show" data-id="' + esc(p.id) + '">' +
      '<h3>' + esc(p.name) + (p.autoStatus ? '<span class="auto-tag" title="Status folgt den Terminen">auto</span>' : '') + '</h3>' +
      '<div class="project-meta">' +
        (p.kunde ? '<span>' + esc(p.kunde) + '</span>' : '') +
        '<span>' + esc(scheduleText(p)) + '</span>' +
        (strassenText(p) ? '<span>' + esc(strassenText(p)) + '</span>' : '') +
      '</div>' +
      (p.liefertermin ? '<div class="project-meta">' + lieferText(p) + '</div>' : '') +
    '</div>';
  }

  /* ---------- Ansichten ---------- */

  function pageHead(title, sub, extra) {
    return '<header class="page-head"><div><h1>' + esc(title) + '</h1>' +
      (sub ? '<p class="page-sub">' + esc(sub) + '</p>' : '') + '</div>' + (extra || '') + '</header>';
  }

  var newBtn = '<button type="button" class="btn btn-primary" data-action="new">+ Neues Projekt</button>';

  function sortedFiltered() {
    var q = ui.q.trim().toLowerCase();
    var list = projects.filter(function (p) {
      if (p.archived) return false;
      if (!q) return true;
      return (p.name + ' ' + p.kunde + ' ' + p.ort).toLowerCase().indexOf(q) !== -1;
    });
    var s = ui.sort;
    list.sort(function (a, b) {
      if (s === 'name') return a.name.localeCompare(b.name, 'de');
      if (s === 'liefer-asc') {
        if (!a.liefertermin && !b.liefertermin) return 0;
        if (!a.liefertermin) return 1;
        if (!b.liefertermin) return -1;
        return a.liefertermin.localeCompare(b.liefertermin);
      }
      if (s === 'start-asc' || s === 'start-desc') {
        if (!a.start && !b.start) return 0;
        if (!a.start) return 1;
        if (!b.start) return -1;
        return s === 'start-asc' ? a.start.localeCompare(b.start) : b.start.localeCompare(a.start);
      }
      if (s === 'created-asc') return a.created.localeCompare(b.created);
      return b.created.localeCompare(a.created);
    });
    return list;
  }

  function renderProjectList() {
    var list = sortedFiltered();
    var box = $('#projList');
    if (!box) return;
    box.innerHTML = list.length
      ? list.map(projectCard).join('')
      : '<div class="empty">' + (ui.q ? 'Keine Projekte gefunden.' : 'Noch keine Projekte. Lege das erste Projekt an.') + '</div>';
  }

  function viewProjects() {
    var active = projects.filter(function (p) { return !p.archived; }).length;
    view.innerHTML =
      pageHead('Projekte', active + (active === 1 ? ' aktives Projekt' : ' aktive Projekte'), newBtn) +
      '<div class="toolbar">' +
        '<label class="sr-only" for="searchBox">Projekte durchsuchen</label>' +
        '<input type="search" id="searchBox" placeholder="Suchen (Name, Kunde, Ort)" value="' + esc(ui.q) + '">' +
        '<label class="sr-only" for="sortSel">Sortierung</label>' +
        '<select id="sortSel">' +
          [['created-desc', 'Erstellt: neueste zuerst'], ['created-asc', 'Erstellt: älteste zuerst'],
           ['start-asc', 'Fertigungsstart: frühester zuerst'], ['start-desc', 'Fertigungsstart: spätester zuerst'],
           ['liefer-asc', 'Liefertermin: nächster zuerst'],
           ['name', 'Name A–Z']].map(function (o) {
            return '<option value="' + o[0] + '"' + (ui.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      '<div class="project-list" id="projList"></div>';
    renderProjectList();
  }

  function viewKanban() {
    var cols = STATUS.map(function (s) {
      var items = projects.filter(function (p) { return !p.archived && p.status === s.key; });
      return '<section class="column" data-drop-status="' + s.key + '" aria-label="' + esc(s.label) + '">' +
        '<div class="column-head">' + badge(s.key) + '<span class="num">' + items.length + '</span></div>' +
        '<div class="column-body">' + items.map(miniCard).join('') + '</div>' +
      '</section>';
    }).join('');
    view.innerHTML = pageHead('Kanban',
        'Der Status folgt den Terminen. Eine Karte von Hand zu ziehen schaltet die Automatik für dieses Projekt ab.', newBtn) +
      '<div class="kanban">' + cols + '</div>';
  }

  function viewArchive() {
    var list = projects.filter(function (p) { return p.archived; })
      .sort(function (a, b) { return b.created.localeCompare(a.created); });
    view.innerHTML = pageHead('Archiv', 'Archivierte Projekte bleiben gespeichert, bis du sie löschst. Aufbewahrungsfristen beachten.') +
      '<div class="project-list">' +
      (list.length ? list.map(projectCard).join('') : '<div class="empty">Das Archiv ist leer.</div>') +
      '</div>';
  }

  function viewStrassen() {
    var rows = strassen.map(function (s, i) {
      var used = projects.filter(function (p) { return !p.archived && p.dauer[s.id] > 0; }).length;
      return '<div class="str-row">' +
        '<span class="str-pos">' + (i + 1) + '</span>' +
        '<input type="text" maxlength="60" value="' + esc(s.name) + '" aria-label="Name der Fertigungsstraße" data-str-name="' + esc(s.id) + '">' +
        '<span class="hint">' + used + (used === 1 ? ' Projekt' : ' Projekte') + '</span>' +
        '<button type="button" class="btn btn-sm" data-action="str-up" data-sid="' + esc(s.id) + '" aria-label="Nach oben"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="btn btn-sm" data-action="str-down" data-sid="' + esc(s.id) + '" aria-label="Nach unten"' + (i === strassen.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-action="str-del" data-sid="' + esc(s.id) + '">Löschen</button>' +
      '</div>';
    }).join('');
    view.innerHTML = pageHead('Fertigungsstraßen',
        'Die Reihenfolge bestimmt, in welcher Folge ein Projekt die Straßen durchläuft.',
        '<button type="button" class="btn btn-primary" data-action="str-add">+ Straße hinzufügen</button>') +
      '<div class="str-list">' + (rows || '<div class="empty">Noch keine Fertigungsstraße angelegt.</div>') + '</div>' +
      '<p class="hint str-note">Jedes Projekt bekommt pro Straße eine Dauer in Tagen. Leer oder 0 heißt: Die Straße ist an dem Projekt nicht beteiligt.</p>';
  }

  /* ---------- Übersichtsseite eines Projekts ---------- */

  function fmtLang(iso) {
    return WOCHENTAGE[(fromISO(iso).getDay() + 6) % 7] + ', ' + fmt(iso);
  }

  function relativText(iso) {
    var n = diffDays(todayISO(), iso);
    if (n === 0) return 'heute';
    if (n === 1) return 'morgen';
    if (n === -1) return 'gestern';
    return n > 0 ? 'in ' + n + ' Tagen' : 'vor ' + (-n) + ' Tagen';
  }

  // Arbeitstage von "von" bis "bis", beide Tage eingeschlossen
  function arbeitstageZwischen(von, bis) {
    if (bis < von) return 0;
    var n = 0, iso = von;
    for (var schutz = 0; iso <= bis && schutz < 4000; schutz++) {
      if (istArbeitstag(iso)) n++;
      iso = addDays(iso, 1);
    }
    return n;
  }

  // Wie viele Arbeitstage der Fertigung sind heute durch?
  function fortschritt(p) {
    if (!p.start) return null;
    var t = todayISO(), s = startOf(p), e = endOf(p), gesamt = totalDauer(p);
    if (t < s) return { getan: 0, gesamt: gesamt, laeuft: false, vorbei: false };
    if (t > e) return { getan: gesamt, gesamt: gesamt, laeuft: false, vorbei: true };
    return { getan: arbeitstageZwischen(s, t), gesamt: gesamt, laeuft: true, vorbei: false };
  }

  function kpi(label, wert, zusatz, klasse) {
    return '<div class="kpi' + (klasse ? ' ' + klasse : '') + '">' +
      '<span class="kpi-label">' + esc(label) + '</span>' +
      '<span class="kpi-wert">' + wert + '</span>' +
      '<span class="kpi-zusatz">' + (zusatz || '&nbsp;') + '</span></div>';
  }

  function dlZeile(label, wert) {
    return '<div class="dl-row"><span class="dl-label">' + esc(label) + '</span>' +
      '<span class="dl-wert">' + wert + '</span></div>';
  }

  function viewProject() {
    var p = find(currentProjectId());
    if (!p) { location.hash = '#/projekte'; return; }

    var hatTermin = !!p.start;
    var start = hatTermin ? startOf(p) : '';
    var ende = hatTermin ? endOf(p) : '';
    var fort = fortschritt(p);

    /* --- Kennzahlen --- */
    var kacheln =
      kpi('Dauer', tage(totalDauer(p)), p.parallel ? 'Abteilungen gleichzeitig' : 'Abteilungen nacheinander') +
      kpi('Fertigungsstart', hatTermin ? fmt(start) : '–',
        hatTermin ? relativText(start) : 'noch nicht eingeplant') +
      kpi('Fertig am', hatTermin ? fmt(ende) : '–',
        hatTermin ? relativText(ende) : '');

    if (p.liefertermin) {
      var zusatz = relativText(p.liefertermin);
      if (hatTermin) {
        if (p.liefertermin < ende) {
          zusatz = '⚠ liegt vor dem Fertigungsende';
        } else {
          var puffer = arbeitstageZwischen(addDays(ende, 1), p.liefertermin);
          zusatz = puffer === 0 ? 'direkt nach der Fertigung' : tage(puffer) + ' Puffer';
        }
      }
      kacheln += kpi('Liefertermin', fmt(p.liefertermin), zusatz, lieferTooEarly(p) ? 'kpi-warn' : '');
    } else {
      kacheln += kpi('Liefertermin', '–', 'kein Termin gesetzt');
    }

    /* --- Fortschritt --- */
    var fortschrittBlock = '';
    if (fort && hatTermin) {
      var prozent = Math.round(fort.getan / fort.gesamt * 100);
      var text = fort.vorbei
        ? 'Fertigung abgeschlossen'
        : (fort.laeuft
            ? 'Tag ' + fort.getan + ' von ' + fort.gesamt + ' – noch ' + tage(fort.gesamt - fort.getan)
            : 'Fertigung hat noch nicht begonnen');
      fortschrittBlock = '<section class="panel fortschritt-box">' +
        '<div class="fortschritt-kopf"><h2>Fortschritt</h2><span class="hint">' + esc(text) + '</span></div>' +
        '<div class="balken"><i class="balken-fuell" data-breite="' + prozent + '"></i></div>' +
        '</section>';
    }

    /* --- Ablauf der Abteilungen als Strahl --- */
    var segs = segments(p);
    var ablauf = '';
    if (segs.length) {
      var spanne = diffDays(start, ende) + 1;
      ablauf = segs.map(function (seg) {
        var links = diffDays(start, seg.start) / spanne * 100;
        var breite = (diffDays(seg.start, seg.end) + 1) / spanne * 100;
        return '<div class="ablauf-row">' +
          '<span class="ablauf-name">' + esc(seg.name) + '</span>' +
          '<div class="ablauf-track"><i class="ablauf-bar st-' + esc(p.status) +
            '" data-links="' + (Math.round(links * 100) / 100) + '" data-breite="' + (Math.round(breite * 100) / 100) + '"></i></div>' +
          '<span class="ablauf-zeit">' + fmt(seg.start) + '–' + fmt(seg.end) + '</span>' +
          '<span class="ablauf-tage">' + tage(seg.tage) + '</span>' +
        '</div>';
      }).join('');
    } else {
      ablauf = strassen.filter(function (st) { return p.dauer[st.id] > 0; }).map(function (st) {
        return '<div class="ablauf-row"><span class="ablauf-name">' + esc(st.name) + '</span>' +
          '<div class="ablauf-track"></div><span class="ablauf-zeit hint">noch kein Termin</span>' +
          '<span class="ablauf-tage">' + tage(p.dauer[st.id]) + '</span></div>';
      }).join('') || '<p class="hint">Keine Abteilung hinterlegt.</p>';
    }

    /* --- Stammdaten --- */
    var stamm =
      dlZeile('Kunde', p.kunde ? esc(p.kunde) : '<span class="hint">nicht erfasst</span>') +
      dlZeile('Ort der Baustelle', p.ort ? esc(p.ort) : '<span class="hint">nicht erfasst</span>') +
      dlZeile('Status', badge(p.status) + (p.autoStatus
        ? ' <span class="hint">folgt den Terminen</span>'
        : ' <span class="hint">von Hand gesetzt</span>')) +
      dlZeile('Fertigungsstart', hatTermin ? fmtLang(start) : '<span class="hint">noch nicht eingeplant</span>') +
      dlZeile('Fertigungsende', hatTermin ? fmtLang(ende) : '<span class="hint">–</span>') +
      dlZeile('Liefertermin', p.liefertermin ? fmtLang(p.liefertermin) : '<span class="hint">kein Termin gesetzt</span>') +
      dlZeile('Arbeitstage', wochenmodus().label) +
      dlZeile('Angelegt am', fmt(p.created.slice(0, 10)));

    var aktionen = '<div class="detail-aktionen">' +
      '<button type="button" class="btn btn-primary" data-action="edit" data-id="' + esc(p.id) + '">Bearbeiten</button>' +
      (p.archived
        ? '<button type="button" class="btn" data-action="restore" data-id="' + esc(p.id) + '">Wiederherstellen</button>' +
          '<button type="button" class="btn btn-danger" data-action="delete" data-id="' + esc(p.id) + '">Löschen</button>'
        : '<button type="button" class="btn" data-action="archive" data-id="' + esc(p.id) + '">Archivieren</button>') +
      '</div>';

    var untertitel = [p.kunde, p.ort].filter(Boolean).map(esc).join(' · ');

    view.innerHTML =
      '<div class="detail-top"><button type="button" class="btn btn-sm" data-action="zurueck">‹ Zurück</button></div>' +
      '<header class="page-head"><div>' +
        '<h1>' + esc(p.name) + '</h1>' +
        (untertitel ? '<p class="page-sub">' + untertitel + '</p>' : '') +
      '</div>' + aktionen + '</header>' +
      '<p class="detail-status">' + badge(p.status) +
        (p.archived ? '<span class="archiv-tag">Archiviert</span>' : '') +
        (p.autoStatus ? '<span class="auto-tag" title="Status folgt den Terminen">auto</span>' : '') +
      '</p>' +
      '<div class="kpi-grid">' + kacheln + '</div>' +
      fortschrittBlock +
      '<section class="panel"><h2>Ablauf der Fertigung</h2><div class="ablauf">' + ablauf + '</div></section>' +
      '<div class="detail-cols">' +
        '<section class="panel"><h2>Angaben</h2>' + stamm + '</section>' +
        '<section class="panel"><h2>Notiz</h2>' +
          (p.notiz ? '<p class="notiz-text">' + esc(p.notiz).replace(/\n/g, '<br>') + '</p>'
                   : '<p class="hint">Keine Notiz hinterlegt.</p>') +
        '</section>' +
      '</div>';

    placeDetail();
  }

  // Breiten der Balken erst nach dem Zeichnen setzen (die CSP verbietet style-Attribute)
  function placeDetail() {
    view.querySelectorAll('.ablauf-bar').forEach(function (el) {
      el.style.left = el.dataset.links + '%';
      el.style.width = 'max(4px, ' + el.dataset.breite + '%)';
    });
    var f = view.querySelector('.balken-fuell');
    if (f) f.style.width = f.dataset.breite + '%';
  }

  /* ---------- Kalender ---------- */

  function calNav() {
    var mode = ui.cal.mode;
    var title = mode === 'jahr' ? String(ui.cal.y) : MONATE[ui.cal.m] + ' ' + ui.cal.y;
    return '<div class="cal-nav">' +
      '<div class="view-toggle" role="group" aria-label="Zeitraum">' +
        '<button type="button" class="btn btn-sm' + (mode === 'monat' ? ' active' : '') + '" data-action="cal-monat"' + (mode === 'monat' ? ' aria-pressed="true"' : '') + '>Monat</button>' +
        '<button type="button" class="btn btn-sm' + (mode === 'jahr' ? ' active' : '') + '" data-action="cal-jahr"' + (mode === 'jahr' ? ' aria-pressed="true"' : '') + '>Jahr</button>' +
      '</div>' +
      '<button type="button" class="btn btn-sm" data-action="cal-prev" aria-label="' + (mode === 'jahr' ? 'Vorheriges Jahr' : 'Vorheriger Monat') + '">‹</button>' +
      '<h2>' + esc(title) + '</h2>' +
      '<button type="button" class="btn btn-sm" data-action="cal-next" aria-label="' + (mode === 'jahr' ? 'Nächstes Jahr' : 'Nächster Monat') + '">›</button>' +
      '<button type="button" class="btn btn-sm" data-action="cal-today">Heute</button>' +
      '<label class="we-toggle" for="weSel" title="Welche Wochentage gefertigt wird. Nicht gewählte Tage werden ausgeblendet und zählen nicht als Fertigungstage.">Arbeitstage</label>' +
      '<select id="weSel" class="we-sel">' +
        WOCHENMODI.map(function (mo) {
          return '<option value="' + mo.key + '"' + (mo.key === wochenmodus().key ? ' selected' : '') + '>' + mo.label + '</option>';
        }).join('') +
      '</select>' +
      '</div>';
  }

  /* Fällt ein Liefertermin bei ausgeblendetem Wochenende auf Sa/So, hat er keine
     eigene Kachel mehr. Er wird dann auf den nächsten Werktag gelegt und trägt
     sein echtes Datum im Chip, damit er nicht einfach verschwindet. */
  function lieferByDay() {
    var map = {};
    projects.forEach(function (p) {
      if (p.archived || !p.liefertermin) return;
      var tag = naechsterArbeitstag(p.liefertermin);
      (map[tag] = map[tag] || []).push(p);
    });
    return map;
  }

  // Abteilungen und Dauer stehen im Tooltip, nicht als eigene Kalenderzeile
  function balkenTitel(p) {
    var ab = strassenText(p);
    return p.name + ' – ' + statusLabel(p.status) + ' (' + scheduleText(p) + ')' + (ab ? ' – ' + ab : '');
  }

  // Bahnen berechnen, damit mehrtägige Balken in jeder Zeile auf gleicher Höhe liegen
  function assignLanes(list) {
    var lanes = [];
    var result = {};
    list.slice().sort(function (a, b) { return a.start.localeCompare(b.start) || a.name.localeCompare(b.name, 'de'); })
      .forEach(function (p) {
        var s = startOf(p), e = endOf(p), i = 0;
        while (lanes[i] && lanes[i] >= s) i++;
        lanes[i] = e;
        result[p.id] = i;
      });
    return { lane: result, count: lanes.length };
  }

  function lieferChip(p) {
    var verschoben = !istArbeitstag(p.liefertermin);
    var titel = 'Liefertermin: ' + fmt(p.liefertermin) + ' – ' + p.name +
      (verschoben ? ' – fällt auf einen ausgeblendeten Tag, hier am nächsten Arbeitstag gezeigt' : '') +
      (lieferTooEarly(p) ? ' – ⚠ liegt vor der Fertigstellung' : '');
    return '<div class="liefer-chip' + (lieferTooEarly(p) ? ' warn' : '') + (verschoben ? ' verschoben' : '') +
      '" draggable="true" data-drag-id="' + esc(p.id) + '" data-drag-kind="liefer" data-action="show" data-id="' + esc(p.id) +
      '" title="' + esc(titel) + '">◆ ' + (verschoben ? esc(fmt(p.liefertermin).slice(0, 6)) + ' ' : '') +
      esc(p.name) + '</div>';
  }

  // nurMonat: im Jahreskalender bleiben die Tage der Nachbarmonate leer,
  // sonst stünde jeder Übergangstag in zwei Monatsrastern.
  function monthGrid(y, m, nurMonat) {
    var offset = (new Date(y, m, 1).getDay() + 6) % 7;
    var gridStart = toISO(new Date(y, m, 1 - offset));
    var gridEnd = addDays(gridStart, 41);
    var today = todayISO();
    var liefer = lieferByDay();
    var spalten = sichtbareSpalten();

    var scheduled = projects.filter(function (p) {
      return !p.archived && p.start && p.start <= gridEnd && endOf(p) >= gridStart;
    });
    var lanes = assignLanes(scheduled);
    // Mehrere Projekte können dieselbe Bahn zeitlich nacheinander nutzen
    var laneProjects = [];
    for (var l = 0; l < lanes.count; l++) laneProjects[l] = [];
    scheduled.forEach(function (p) { laneProjects[lanes.lane[p.id]].push(p); });

    var html = '<div class="cal sp' + spalten.length + '"><div class="cal-kw-head">KW</div>';
    spalten.forEach(function (c) { html += '<div class="cal-dow">' + WOCHENTAGE[c] + '</div>'; });

    for (var w = 0; w < 6; w++) {
      var wochenStart = addDays(gridStart, w * 7);
      html += '<div class="cal-kw">' + isoWeek(wochenStart) + '</div>';

      for (var ci = 0; ci < spalten.length; ci++) {
        var col = spalten[ci];
        var iso = addDays(wochenStart, col);
        var d = fromISO(iso);
        if (nurMonat && d.getMonth() !== m) { html += '<div class="cal-day blank"></div>'; continue; }
        var cls = 'cal-day' + (d.getMonth() !== m ? ' other' : '') + (col >= 5 ? ' weekend' : '') + (iso === today ? ' today' : '');
        html += '<div class="' + cls + '" data-drop-day="' + iso + '"><span class="cal-num">' + d.getDate() + '</span>';

        for (var ln = 0; ln < lanes.count; ln++) {
          var hit = laneProjects[ln].filter(function (p) { return startOf(p) <= iso && endOf(p) >= iso; })[0];
          if (!hit) { html += '<div class="chip-spacer"></div>'; continue; }
          var isFirst = startOf(hit) === iso, isLast = endOf(hit) === iso;
          var showName = isFirst || ci === 0;
          html += '<div class="chip st-' + esc(hit.status) + (isFirst ? ' first' : ' cont') + (isLast ? ' last' : '') +
            '" draggable="true" data-drag-id="' + esc(hit.id) + '" data-drag-day="' + iso + '" data-action="show" data-id="' + esc(hit.id) +
            '" title="' + esc(balkenTitel(hit)) + '">' + (showName ? esc(hit.name) : '&nbsp;') + '</div>';
        }

        html += (liefer[iso] || []).map(lieferChip).join('');
        html += '</div>';
      }
    }
    return html + '</div>';
  }

  /* Jahreskalender: zwölf echte Monatsraster nebeneinander – gleiche Kacheln und
     gleiche Balken wie in der Monatsansicht, nur mehrere Monate pro Reihe. */
  function yearCal() {
    var y = ui.cal.y;
    var html = '<div class="ycal">';
    for (var m = 0; m < 12; m++) {
      html += '<section class="ymon"><h3>' + MONATE[m] + '</h3>' + monthGrid(y, m, true) + '</section>';
    }
    return html + '</div>';
  }

  function calSide() {
    var t = todayISO(), limit = addDays(t, 14);
    var soon = projects.filter(function (p) {
      return !p.archived && p.liefertermin && p.liefertermin >= t && p.liefertermin <= limit;
    }).sort(function (a, b) { return a.liefertermin.localeCompare(b.liefertermin); });
    var unscheduled = projects.filter(function (p) { return !p.archived && !p.start; });

    return '<aside class="cal-side">' +
      '<section class="panel"><h2>Lieferungen (14 Tage)</h2>' +
      (soon.length
        ? '<ul class="side-list">' + soon.map(function (p) {
            return '<li' + (lieferTooEarly(p) ? ' class="hint-warn"' : '') + '>' +
              '<button type="button" class="link" data-action="show" data-id="' + esc(p.id) + '">' +
              '<strong>' + fmt(p.liefertermin) + '</strong> ' + esc(p.name) + '</button></li>';
          }).join('') + '</ul>'
        : '<p class="hint">Keine Lieferung in den nächsten 14 Tagen.</p>') +
      '</section>' +
      '<section class="panel"><h2>Nicht eingeplant</h2>' +
      '<p class="hint">Karte auf einen Kalendertag ziehen, um den Fertigungsstart festzulegen.</p>' +
      (unscheduled.length ? unscheduled.map(miniCard).join('') : '<p class="hint">Alle Projekte sind eingeplant.</p>') +
      '</section></aside>';
  }

  function viewCalendar() {
    var jahr = ui.cal.mode === 'jahr';
    var sub = jahr
      ? 'Alle zwölf Monate mit den Projektbalken. ◆ ist der Liefertermin.'
      : 'Projekte per Drag & Drop verschieben. ◆ ist der Liefertermin, er lässt sich ebenfalls ziehen.';
    view.innerHTML = pageHead('Kalender', sub, calNav() + newBtn) +
      '<div class="cal-layout' + (jahr ? ' jahr' : '') + '"><div class="cal-main">' + (jahr ? yearCal() : monthGrid(ui.cal.y, ui.cal.m)) + '</div>' + calSide() + '</div>';
  }

  /* ---------- Routing ---------- */

  var routes = {
    projekt: viewProject,
    projekte: viewProjects,
    kanban: viewKanban,
    kalender: viewCalendar,
    strassen: viewStrassen,
    archiv: viewArchive
  };

  function hashTeil() { return (location.hash || '').replace(/^#\/?/, ''); }

  function currentRoute() {
    var r = hashTeil();
    if (r.indexOf('projekt/') === 0) return 'projekt';
    return routes[r] ? r : 'projekte';
  }

  function currentProjectId() {
    var r = hashTeil();
    return r.indexOf('projekt/') === 0 ? r.slice('projekt/'.length) : '';
  }

  function render() {
    if (aktualisiereStatus()) save();
    var r = currentRoute();
    var aktiv = (r === 'projekt') ? 'projekte' : r;
    document.querySelectorAll('.nav a').forEach(function (a) {
      if (a.dataset.route === aktiv) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    routes[r]();
  }

  /* ---------- Dialog ---------- */

  /* Eigenes Datumsfeld: Das Kalender-Popup des Browsers zeigt immer alle sieben
     Wochentage und lässt sich nicht einschränken. Dieses hier zeigt nur die
     eingestellten Arbeitstage und sperrt Tage vor dem erlaubten Minimum. */
  var popMonat = {};

  function datumFeld(ziel, label, name, iso) {
    return '<div class="datumsfeld" data-ziel="' + ziel + '">' +
      '<span class="feld-label" id="lbl-' + ziel + '">' + esc(label) + '</span>' +
      '<div class="datum-zeile">' +
        '<input type="hidden" name="' + name + '" id="f-' + ziel + '" value="' + esc(iso) + '">' +
        '<button type="button" class="datum-btn" id="btn-' + ziel + '" data-action="datum-auf" data-ziel="' + ziel +
          '" aria-labelledby="lbl-' + ziel + ' btn-' + ziel + '">' + (iso ? fmt(iso) : 'Kein Datum') + '</button>' +
        '<button type="button" class="btn btn-sm datum-x" data-action="datum-leeren" data-ziel="' + ziel +
          '" aria-label="Datum löschen"' + (iso ? '' : ' hidden') + '>×</button>' +
      '</div>' +
      '<div class="datum-pop" id="pop-' + ziel + '" hidden></div>' +
    '</div>';
  }

  // Der Liefertermin darf nicht vor dem Fertigungsende liegen
  function datumMin(ziel) {
    if (ziel !== 'liefer') return '';
    var sf = $('#f-start');
    if (!sf || !sf.value) return '';
    return endOf(normalize(readForm()));
  }

  function datumPopHTML(ziel) {
    var iso = $('#f-' + ziel).value;
    var min = datumMin(ziel);
    var basis = popMonat[ziel] || iso || min || todayISO();
    var d = fromISO(basis);
    var y = d.getFullYear(), m = d.getMonth();
    var spalten = sichtbareSpalten();
    var offset = (new Date(y, m, 1).getDay() + 6) % 7;
    var gridStart = toISO(new Date(y, m, 1 - offset));
    var today = todayISO();

    var h = '<div class="pop-kopf">' +
      '<button type="button" class="btn btn-sm" data-action="datum-prev" data-ziel="' + ziel + '" aria-label="Vorheriger Monat">‹</button>' +
      '<strong>' + MONATE[m] + ' ' + y + '</strong>' +
      '<button type="button" class="btn btn-sm" data-action="datum-next" data-ziel="' + ziel + '" aria-label="Nächster Monat">›</button>' +
      '</div><div class="pop-grid sp' + spalten.length + '"><span class="pop-kw-head">KW</span>';
    spalten.forEach(function (c) { h += '<span class="pop-dow">' + WOCHENTAGE[c] + '</span>'; });

    for (var w = 0; w < 6; w++) {
      var wochenStart = addDays(gridStart, w * 7);
      h += '<span class="pop-kw">' + isoWeek(wochenStart) + '</span>';
      for (var i = 0; i < spalten.length; i++) {
        var tag = addDays(wochenStart, spalten[i]);
        var td = fromISO(tag);
        var cls = 'pop-tag' + (td.getMonth() !== m ? ' fremd' : '') +
          (tag === iso ? ' gewaehlt' : '') + (tag === today ? ' heute' : '');
        h += (min && tag < min)
          ? '<span class="' + cls + ' gesperrt">' + td.getDate() + '</span>'
          : '<button type="button" class="' + cls + '" data-action="datum-waehlen" data-ziel="' + ziel +
            '" data-iso="' + tag + '">' + td.getDate() + '</button>';
      }
    }
    return h + '</div>';
  }

  function setzeDatum(ziel, iso) {
    var inp = $('#f-' + ziel);
    if (!inp) return;
    inp.value = iso;
    var btn = $('#btn-' + ziel);
    if (btn) btn.textContent = iso ? fmt(iso) : 'Kein Datum';
    var x = document.querySelector('[data-action="datum-leeren"][data-ziel="' + ziel + '"]');
    if (x) x.hidden = !iso;
  }

  function schliesseDatumPops() {
    document.querySelectorAll('.datum-pop').forEach(function (el) { el.hidden = true; });
  }

  function zeigeDatumPop(ziel) {
    var pop = $('#pop-' + ziel);
    if (!pop) return;
    pop.innerHTML = datumPopHTML(ziel);
    pop.hidden = false;
    pop.scrollIntoView({ block: 'nearest' });
  }

  function segRow(s, n) {
    return '<div class="seg-row">' +
      '<label for="f-d-' + esc(s.id) + '">' + esc(s.name) + '</label>' +
      '<input id="f-d-' + esc(s.id) + '" type="number" min="0" step="1" placeholder="0" data-dauer="' + esc(s.id) + '" value="' + (n > 0 ? n : '') + '">' +
    '</div>';
  }

  function openDialog(id) {
    var p = id ? find(id) : normalize({ name: '' });
    p.name = id ? p.name : '';
    dialog.dataset.id = id || '';
    dialog.innerHTML =
      '<form id="projectForm" autocomplete="off">' +
      '<div class="dlg-head"><h2 id="dialogTitle">' + (id ? 'Projekt bearbeiten' : 'Neues Projekt') + '</h2></div>' +
      '<div class="dlg-body">' +

        '<section class="dlg-sec">' +
          '<h3>1. Projekt</h3>' +
          '<div class="feld-grid">' +
            '<div class="full"><label for="f-name">Projektname *</label>' +
              '<input id="f-name" name="name" required maxlength="120" value="' + esc(p.name) + '"></div>' +
            '<div><label for="f-kunde">Kunde</label>' +
              '<input id="f-kunde" name="kunde" maxlength="120" value="' + esc(p.kunde) + '"></div>' +
            '<div><label for="f-ort">Ort der Baustelle</label>' +
              '<input id="f-ort" name="ort" maxlength="120" value="' + esc(p.ort) + '"></div>' +
            '<div><label for="f-status">Status</label>' +
              '<select id="f-status" name="status"' + (p.autoStatus ? ' disabled' : '') + '>' +
                STATUS.map(function (st) {
                  return '<option value="' + st.key + '"' + (p.status === st.key ? ' selected' : '') + '>' + st.label + '</option>';
                }).join('') +
              '</select>' +
              '<label class="check check-klein"><input type="checkbox" name="autoStatus" id="f-auto"' +
                (p.autoStatus ? ' checked' : '') + '> Automatisch aus den Terminen</label>' +
            '</div>' +
          '</div>' +
        '</section>' +

        '<section class="dlg-sec">' +
          '<h3>2. Wie lange dauert die Fertigung?</h3>' +
          '<p class="sec-hint">Tage je Abteilung. Leer oder 0 heißt: Die Abteilung ist nicht beteiligt.</p>' +
          (strassen.length
            ? '<div class="seg-grid">' + strassen.map(function (st) { return segRow(st, p.dauer[st.id] || 0); }).join('') + '</div>'
            : '<p class="hint">Noch keine Fertigungsstraße angelegt – unter „Fertigungsstraßen“ anlegen.</p>') +
          '<label class="check"><input type="checkbox" name="parallel"' + (p.parallel ? ' checked' : '') + '> ' +
            'Abteilungen arbeiten gleichzeitig (sonst nacheinander in der Reihenfolge oben)</label>' +
        '</section>' +

        '<section class="dlg-sec">' +
          '<h3>3. Wann?</h3>' +
          '<div class="feld-grid">' +
            datumFeld('start', 'Fertigungsstart', 'start', p.start) +
            datumFeld('liefer', 'Liefertermin', 'liefertermin', p.liefertermin) +
          '</div>' +
          '<div class="calc-box" id="calcBox"></div>' +
        '</section>' +

        '<section class="dlg-sec">' +
          '<h3>4. Notiz</h3>' +
          '<textarea id="f-notiz" name="notiz" maxlength="2000" aria-label="Notiz">' + esc(p.notiz) + '</textarea>' +
        '</section>' +

      '</div>' +
      '<div class="dlg-foot">' +
        '<button type="button" class="btn" data-action="dlg-cancel">Abbrechen</button>' +
        '<button type="submit" class="btn btn-primary">Speichern</button>' +
      '</div></form>';
    updateCalc();
    dialog.showModal();
    $('#f-name').focus();
  }

  function readForm() {
    var f = $('#projectForm');
    var dauer = {};
    f.querySelectorAll('[data-dauer]').forEach(function (inp) {
      var n = parseInt(inp.value, 10);
      if (n > 0) dauer[inp.dataset.dauer] = n;
    });
    var el = f.elements;
    return {
      name: el.name.value.trim(),
      kunde: el.kunde.value.trim(),
      ort: el.ort.value.trim(),
      status: el.status.value,
      autoStatus: el.autoStatus.checked,
      dauer: dauer,
      parallel: el.parallel.checked,
      start: el.start.value,
      liefertermin: el.liefertermin.value,
      notiz: el.notiz.value
    };
  }

  /* Zeigt kompakt, was sich aus Dauer und Start ergibt, und begrenzt den
     Liefertermin nach unten auf das Fertigungsende. */
  function updateCalc() {
    var box = $('#calcBox');
    if (!box) return;
    var data = normalize(readForm());
    var autoBox = $('#f-auto'), statusFeld = $('#f-status');
    if (autoBox && autoBox.checked && statusFeld) statusFeld.value = data.status;

    if (!data.start) {
      box.innerHTML = '<div>Gesamtdauer <strong>' + tage(totalDauer(data)) + '</strong>. ' +
        'Sobald ein Fertigungsstart steht, wird hier das Fertigungsende berechnet.</div>';
      return;
    }

    var start = startOf(data), ende = endOf(data);

    var zeilen = ['Fertig am <strong>' + fmt(ende) + '</strong> &nbsp;·&nbsp; Start ' + fmt(start) +
      ' &nbsp;·&nbsp; ' + tage(totalDauer(data)) + (data.parallel ? ', gleichzeitig' : ', nacheinander')];

    var segs = segments(data);
    if (segs.length > 1) {
      zeilen.push('<span class="calc-seg">' + segs.map(function (seg) {
        return esc(seg.name) + ' ' + fmt(seg.start) + '–' + fmt(seg.end);
      }).join(' · ') + '</span>');
    }

    if (data.start !== start) {
      zeilen.push('<span class="hint">Der gewählte Tag ist kein Arbeitstag, die Fertigung beginnt am ' + fmt(start) + '.</span>');
    }
    if (data.liefertermin && data.liefertermin < ende) {
      zeilen.push('<span class="hint-warn">⚠ Der Liefertermin liegt vor dem Fertigungsende.</span>');
    }

    box.innerHTML = '<div>' + zeilen.join('<br>') + '</div>' +
      '<button type="button" class="btn btn-sm" data-action="apply-liefer" data-date="' + ende +
      '">Liefertermin aufs Fertigungsende setzen</button>';
  }

  /* Hält die beiden Datumsfelder im erlaubten Rahmen: nur eingestellte Arbeitstage,
     und der Liefertermin nie vor dem Fertigungsende. */
  function erzwingeTermine() {
    var sf = $('#f-start'), lf = $('#f-liefer');
    if (!sf || !lf) return;
    if (sf.value && !istArbeitstag(sf.value)) setzeDatum('start', naechsterArbeitstag(sf.value));
    if (lf.value && !istArbeitstag(lf.value)) setzeDatum('liefer', naechsterArbeitstag(lf.value));
    if (sf.value && lf.value) {
      var ende = endOf(normalize(readForm()));
      if (lf.value < ende) setzeDatum('liefer', ende);
    }
  }

  function saveForm() {
    var data = readForm();
    if (!data.name) return;
    var id = dialog.dataset.id;
    if (id) {
      var p = find(id);
      Object.assign(p, normalize(Object.assign({}, p, data, { id: p.id, created: p.created, archived: p.archived })));
    } else {
      projects.push(normalize(data));
    }
    save();
    dialog.close();
    render();
  }

  /* ---------- Aktionen ---------- */

  function effectiveTheme() {
    return document.documentElement.dataset.theme ||
      (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  var ICON_MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
  var ICON_SUN = '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';

  // Zeigt das Symbol des Modus, zu dem der Klick wechselt
  function updateThemeButton() {
    var dark = effectiveTheme() === 'dark';
    var label = dark ? 'Zum Hellmodus wechseln' : 'Zum Dunkelmodus wechseln';
    var btn = $('#themeBtn');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    $('#themeIcon').innerHTML = dark ? ICON_SUN : ICON_MOON;
  }

  function toggleTheme() {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* egal */ }
    updateThemeButton();
  }

  function exportData() {
    var blob = new Blob([JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), einstellungen: { sa: einst.sa, so: einst.so }, strassen: strassen, projects: projects }, null, 2)],
      { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'schornstein-planer-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.projects)) throw new Error('Format');
        if (!confirm(data.projects.length + ' Projekte importieren? Die aktuellen Daten werden ersetzt.')) return;
        if (Array.isArray(data.strassen) && data.strassen.length) strassen = data.strassen.map(normalizeStrasse);
        if (data.einstellungen) leseEinstellungen(data.einstellungen);
        projects = data.projects.map(normalize);
        save();
        render();
      } catch (e) {
        alert('Die Datei konnte nicht gelesen werden. Erwartet wird ein Export aus dem Schornstein-Planer.');
      }
    };
    reader.readAsText(file);
  }

  function moveCal(delta) {
    if (ui.cal.mode === 'jahr') { ui.cal.y += delta; render(); return; }
    var d = new Date(ui.cal.y, ui.cal.m + delta, 1);
    ui.cal.y = d.getFullYear();
    ui.cal.m = d.getMonth();
    render();
  }

  function moveStrasse(id, delta) {
    var i = strassen.findIndex(function (s) { return s.id === id; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= strassen.length) return;
    var tmp = strassen[i];
    strassen[i] = strassen[j];
    strassen[j] = tmp;
    save();
    render();
  }

  var actions = {
    'new': function () { openDialog(null); },
    'show': function (el) { location.hash = '#/projekt/' + el.dataset.id; },
    'edit': function (el) { openDialog(el.dataset.id); },
    'zurueck': function () { if (history.length > 1) history.back(); else location.hash = '#/projekte'; },
    'archive': function (el) { var p = find(el.dataset.id); if (p) { p.archived = true; save(); render(); } },
    'restore': function (el) { var p = find(el.dataset.id); if (p) { p.archived = false; save(); render(); } },
    'delete': function (el) {
      var p = find(el.dataset.id);
      if (p && confirm('Projekt "' + p.name + '" endgültig löschen? Das kann nicht rückgängig gemacht werden.')) {
        projects = projects.filter(function (x) { return x.id !== p.id; });
        save(); render();
      }
    },
    'toggle-theme': toggleTheme,
    'export': exportData,
    'import': function () { $('#importFile').click(); },
    'cal-prev': function () { moveCal(-1); },
    'cal-next': function () { moveCal(1); },
    'cal-today': function () {
      var n = new Date();
      ui.cal.y = n.getFullYear();
      ui.cal.m = n.getMonth();
      render();
    },
    'cal-monat': function () { ui.cal.mode = 'monat'; render(); },
    'cal-jahr': function () { ui.cal.mode = 'jahr'; render(); },
    'str-add': function () {
      strassen.push(normalizeStrasse({ name: 'Neue Straße' }));
      save(); render();
      var rows = document.querySelectorAll('[data-str-name]');
      if (rows.length) { rows[rows.length - 1].focus(); rows[rows.length - 1].select(); }
    },
    'str-up': function (el) { moveStrasse(el.dataset.sid, -1); },
    'str-down': function (el) { moveStrasse(el.dataset.sid, 1); },
    'str-del': function (el) {
      var id = el.dataset.sid;
      var s = strassen.filter(function (x) { return x.id === id; })[0];
      if (!s) return;
      var used = projects.filter(function (p) { return p.dauer[id] > 0; }).length;
      var frage = 'Fertigungsstraße "' + s.name + '" löschen?' +
        (used ? '\n\nDie eingetragene Dauer wird bei ' + used + ' Projekt(en) entfernt.' : '');
      if (!confirm(frage)) return;
      strassen = strassen.filter(function (x) { return x.id !== id; });
      projects = projects.map(function (p) { delete p.dauer[id]; return normalize(p); });
      save(); render();
    },
    'dlg-cancel': function () { dialog.close(); },
    'apply-liefer': function (el) { setzeDatum('liefer', el.dataset.date); updateCalc(); },
    'datum-auf': function (el) {
      var ziel = el.dataset.ziel;
      var offen = !$('#pop-' + ziel).hidden;
      schliesseDatumPops();
      if (!offen) { popMonat[ziel] = null; zeigeDatumPop(ziel); }
    },
    'datum-leeren': function (el) { setzeDatum(el.dataset.ziel, ''); schliesseDatumPops(); erzwingeTermine(); updateCalc(); },
    'datum-prev': function (el) { datumBlaettern(el.dataset.ziel, -1); },
    'datum-next': function (el) { datumBlaettern(el.dataset.ziel, 1); },
    'datum-waehlen': function (el) {
      setzeDatum(el.dataset.ziel, el.dataset.iso);
      schliesseDatumPops();
      erzwingeTermine();
      updateCalc();
    }
  };

  function datumBlaettern(ziel, delta) {
    var basis = popMonat[ziel] || $('#f-' + ziel).value || datumMin(ziel) || todayISO();
    var d = fromISO(basis);
    popMonat[ziel] = toISO(new Date(d.getFullYear(), d.getMonth() + delta, 1));
    zeigeDatumPop(ziel);
  }

  // Klick neben das Feld schließt den Kalender
  document.addEventListener('click', function (e) {
    if (!(e.target.closest && e.target.closest('.datumsfeld'))) schliesseDatumPops();
  });

  dialog.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.querySelector('.datum-pop:not([hidden])')) {
      e.preventDefault();
      e.stopPropagation();
      schliesseDatumPops();
    }
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.dataset.action];
    if (fn) fn(el);
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'searchBox') { ui.q = e.target.value; renderProjectList(); }
    else if (e.target.dataset && e.target.dataset.strName) {
      var s = strassen.filter(function (x) { return x.id === e.target.dataset.strName; })[0];
      if (s) { s.name = e.target.value.slice(0, 60); save(); }
    }
    else if (e.target.closest && e.target.closest('#projectForm')) updateCalc();
  });

  document.addEventListener('change', function (e) {
    if (e.target.id === 'weSel') {
      var mo = WOCHENMODI.filter(function (x) { return x.key === e.target.value; })[0] || WOCHENMODI[0];
      einst.sa = mo.sa;
      einst.so = mo.so;
      save(); render();
    }
    else if (e.target.id === 'sortSel') { ui.sort = e.target.value; renderProjectList(); }
    else if (e.target.id === 'f-auto') {
      $('#f-status').disabled = e.target.checked;
      updateCalc();
    }
    else if (e.target.closest && e.target.closest('#projectForm')) { erzwingeTermine(); updateCalc(); }
  });

  dialog.addEventListener('submit', function (e) { e.preventDefault(); saveForm(); });

  $('#importFile').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });

  /* ---------- Drag & Drop (Kanban + Kalender) ---------- */

  document.addEventListener('dragstart', function (e) {
    var el = e.target.closest && e.target.closest('[data-drag-id]');
    if (!el) return;
    drag = { id: el.dataset.dragId, day: el.dataset.dragDay || null, kind: el.dataset.dragKind || 'start' };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id); // Firefox benötigt Daten, damit der Drag startet
  });

  document.addEventListener('dragend', function () {
    drag = null;
    document.querySelectorAll('.dragging, .drag-over').forEach(function (el) { el.classList.remove('dragging', 'drag-over'); });
  });

  function dropTarget(e) { return e.target.closest && e.target.closest('[data-drop-status], [data-drop-day]'); }

  document.addEventListener('dragover', function (e) {
    var t = dropTarget(e);
    if (!drag || !t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.drag-over').forEach(function (el) { if (el !== t) el.classList.remove('drag-over'); });
    t.classList.add('drag-over');
  });

  document.addEventListener('drop', function (e) {
    var t = dropTarget(e);
    if (!drag || !t) return;
    e.preventDefault();
    var p = find(drag.id);
    if (p) {
      if (t.dataset.dropStatus) {
        p.status = t.dataset.dropStatus;
        p.autoStatus = false;
      } else if (t.dataset.dropDay) {
        if (drag.kind === 'liefer') {
          p.liefertermin = t.dataset.dropDay;
        } else {
          p.start = (drag.day && p.start) ? addDays(p.start, diffDays(drag.day, t.dataset.dropDay)) : t.dataset.dropDay;
        }
      }
      save();
    }
    drag = null;
    render();
  });

  /* ---------- Start ---------- */

  window.addEventListener('hashchange', render);
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onChange = updateThemeButton;
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }

  load();
  updateThemeButton();
  render();
})();
