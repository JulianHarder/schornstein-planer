/* Schornstein-Planer – erster Entwurf
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
  var WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

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

  function statusLabel(key) {
    var s = STATUS.filter(function (x) { return x.key === key; })[0];
    return s ? s.label : key;
  }

  /* ---------- Daten ---------- */

  var projects = [];

  function normalize(p) {
    var status = STATUS.some(function (s) { return s.key === p.status; }) ? p.status : 'planung';
    return {
      id: String(p.id || uid()),
      name: String(p.name || 'Unbenannt'),
      kunde: String(p.kunde || ''),
      ort: String(p.ort || ''),
      status: status,
      bestelldatum: /^\d{4}-\d{2}-\d{2}$/.test(p.bestelldatum || '') ? p.bestelldatum : '',
      start: /^\d{4}-\d{2}-\d{2}$/.test(p.start || '') ? p.start : '',
      dauer: Math.max(1, parseInt(p.dauer, 10) || 1),
      notiz: String(p.notiz || ''),
      teile: (Array.isArray(p.teile) ? p.teile : []).map(function (t) {
        return { name: String(t.name || ''), lieferzeit: Math.max(0, parseInt(t.lieferzeit, 10) || 0) };
      }),
      created: p.created || new Date().toISOString(),
      archived: !!p.archived
    };
  }

  function seed() {
    var t = todayISO();
    var now = Date.now();
    function created(daysAgo) { return new Date(now - daysAgo * 864e5).toISOString(); }
    return [
      { name: 'Edelstahlschornstein Einfamilienhaus', kunde: 'Familie Beispiel', ort: 'Musterstadt', status: 'bearbeitung',
        bestelldatum: addDays(t, -20), start: addDays(t, -2), dauer: 4, created: created(18),
        teile: [{ name: 'Schornsteinrohr DN 150', lieferzeit: 10 }, { name: 'Mündungsabschluss', lieferzeit: 14 }] },
      { name: 'Sanierung Hotelkamin', kunde: 'Hotel Beispielhof', ort: 'Beispieldorf', status: 'planung',
        bestelldatum: t, start: addDays(t, 24), dauer: 7, created: created(6),
        teile: [{ name: 'Edelstahl-Doppelwandrohr', lieferzeit: 28 }, { name: 'Dachdurchführung', lieferzeit: 12 }, { name: 'Reinigungstür', lieferzeit: 5 }] },
      { name: 'Neubau Gewerbehalle', kunde: 'Muster GmbH', ort: 'Testhausen', status: 'planung',
        bestelldatum: '', start: '', dauer: 5, created: created(2),
        teile: [{ name: 'Fertigteilschornstein', lieferzeit: 35 }] },
      { name: 'Kaminkopf erneuern', kunde: 'Herr Test', ort: 'Probenheim', status: 'abgeschlossen',
        bestelldatum: addDays(t, -40), start: addDays(t, -14), dauer: 2, created: created(45),
        teile: [{ name: 'Kaminabdeckung', lieferzeit: 7 }] }
    ].map(normalize);
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (Array.isArray(data.projects)) { projects = data.projects.map(normalize); return; }
      }
    } catch (e) { /* defekt oder nicht verfügbar → Demo-Daten */ }
    projects = seed();
  }

  var storageWarned = false;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, projects: projects }));
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        alert('Der Browser-Speicher ist nicht verfügbar. Änderungen gehen beim Schließen verloren – bitte regelmäßig "Daten exportieren" nutzen.');
      }
    }
  }

  function find(id) { return projects.filter(function (p) { return p.id === id; })[0]; }

  /* ---------- Terminberechnung (zur Laufzeit) ---------- */

  function endOf(p) { return addDays(p.start, p.dauer - 1); }

  // Frühester Start = Bestelldatum (sonst heute) + längste Lieferzeit
  function earliestStart(p) {
    if (!p.teile.length) return null;
    var max = Math.max.apply(null, p.teile.map(function (t) { return t.lieferzeit; }));
    return addDays(p.bestelldatum || todayISO(), max);
  }

  function startTooEarly(p) {
    var e = earliestStart(p);
    return !!(e && p.start && p.status !== 'abgeschlossen' && p.start < e);
  }

  /* ---------- UI-Zustand ---------- */

  var ui = {
    sort: 'created-desc',
    q: '',
    cal: { y: new Date().getFullYear(), m: new Date().getMonth() }
  };
  var drag = null; // { id, day }

  var view = $('#view');
  var dialog = $('#projectDialog');

  /* ---------- Teil-Templates ---------- */

  function scheduleText(p) {
    if (!p.start) return 'Noch nicht eingeplant';
    return fmt(p.start) + ' – ' + fmt(endOf(p)) + ' (' + p.dauer + (p.dauer === 1 ? ' Tag' : ' Tage') + ')';
  }

  function deliveryHint(p) {
    var e = earliestStart(p);
    if (!e) return '';
    var warn = startTooEarly(p);
    return '<span class="' + (warn ? 'hint-warn' : '') + '">' +
      (warn ? '⚠ Start vor Lieferung – ' : '') + 'Frühester Start: ' + fmt(e) + '</span>';
  }

  function badge(status) {
    return '<span class="badge st-' + esc(status) + '">' + esc(statusLabel(status)) + '</span>';
  }

  function projectCard(p) {
    var actions = p.archived
      ? '<button type="button" class="btn btn-sm" data-action="restore" data-id="' + esc(p.id) + '">Wiederherstellen</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-action="delete" data-id="' + esc(p.id) + '">Löschen</button>'
      : '<button type="button" class="btn btn-sm" data-action="edit" data-id="' + esc(p.id) + '">Bearbeiten</button>' +
        '<button type="button" class="btn btn-sm" data-action="archive" data-id="' + esc(p.id) + '">Archivieren</button>';
    return '<article class="project-card" data-status="' + esc(p.status) + '">' +
      '<div><h2>' + esc(p.name) + '</h2>' +
      '<div class="project-meta">' +
        (p.kunde ? '<span>' + esc(p.kunde) + '</span>' : '') +
        (p.ort ? '<span>' + esc(p.ort) + '</span>' : '') +
        '<span>' + esc(scheduleText(p)) + '</span>' +
        '<span>' + deliveryHint(p) + '</span>' +
      '</div></div>' +
      '<div class="project-actions">' + badge(p.status) + actions + '</div>' +
    '</article>';
  }

  function miniCard(p) {
    return '<div class="kcard st-' + esc(p.status) + '" draggable="true" data-drag-id="' + esc(p.id) + '" data-action="edit" data-id="' + esc(p.id) + '">' +
      '<h3>' + esc(p.name) + '</h3>' +
      '<div class="project-meta">' +
        (p.kunde ? '<span>' + esc(p.kunde) + '</span>' : '') +
        '<span>' + esc(scheduleText(p)) + '</span>' +
      '</div>' +
      (earliestStart(p) ? '<div class="project-meta">' + deliveryHint(p) + '</div>' : '') +
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
           ['start-asc', 'Projekttermin: frühester zuerst'], ['start-desc', 'Projekttermin: spätester zuerst'],
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
    view.innerHTML = pageHead('Kanban', 'Karten zwischen den Spalten ziehen, um den Status zu ändern.', newBtn) +
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

  // Bahnen berechnen, damit mehrtägige Balken in jeder Zeile auf gleicher Höhe liegen
  function assignLanes(list) {
    var lanes = [];
    var result = {};
    list.slice().sort(function (a, b) { return a.start.localeCompare(b.start) || a.name.localeCompare(b.name, 'de'); })
      .forEach(function (p) {
        var s = p.start, e = endOf(p), i = 0;
        while (lanes[i] && lanes[i] >= s) i++;
        lanes[i] = e;
        result[p.id] = i;
      });
    return { lane: result, count: lanes.length };
  }

  function viewCalendar() {
    var y = ui.cal.y, m = ui.cal.m;
    var first = new Date(y, m, 1);
    var offset = (first.getDay() + 6) % 7;
    var gridStart = toISO(new Date(y, m, 1 - offset));
    var gridEnd = addDays(gridStart, 41);
    var today = todayISO();

    var scheduled = projects.filter(function (p) {
      return !p.archived && p.start && p.start <= gridEnd && endOf(p) >= gridStart;
    });
    var unscheduled = projects.filter(function (p) { return !p.archived && !p.start; });
    var lanes = assignLanes(scheduled);
    // Mehrere Projekte können dieselbe Bahn zeitlich nacheinander nutzen
    var laneProjects = [];
    for (var l = 0; l < lanes.count; l++) laneProjects[l] = [];
    scheduled.forEach(function (p) { laneProjects[lanes.lane[p.id]].push(p); });

    var html = '<div class="cal">';
    WOCHENTAGE.forEach(function (d) { html += '<div class="cal-dow">' + d + '</div>'; });

    for (var i = 0; i < 42; i++) {
      var iso = addDays(gridStart, i);
      var d = fromISO(iso);
      var col = i % 7;
      var cls = 'cal-day' + (d.getMonth() !== m ? ' other' : '') + (col >= 5 ? ' weekend' : '') + (iso === today ? ' today' : '');
      html += '<div class="' + cls + '" data-drop-day="' + iso + '"><span class="cal-num">' + d.getDate() + '</span>';
      for (var ln = 0; ln < lanes.count; ln++) {
        var hit = laneProjects[ln].filter(function (p) { return p.start <= iso && endOf(p) >= iso; })[0];
        if (!hit) { html += '<div class="chip-spacer"></div>'; continue; }
        var isFirst = hit.start === iso, isLast = endOf(hit) === iso;
        var showName = isFirst || col === 0 || iso === gridStart;
        html += '<div class="chip st-' + esc(hit.status) + (isFirst ? ' first' : ' cont') + (isLast ? ' last' : '') + (startTooEarly(hit) ? ' warn' : '') +
          '" draggable="true" data-drag-id="' + esc(hit.id) + '" data-drag-day="' + iso + '" data-action="edit" data-id="' + esc(hit.id) +
          '" title="' + esc(hit.name + ' – ' + statusLabel(hit.status) + ' (' + scheduleText(hit) + ')') + '">' +
          (showName ? esc(hit.name) : '&nbsp;') + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    var side = '<aside class="unscheduled"><h2>Nicht eingeplant</h2>' +
      '<p class="hint">Karte auf einen Kalendertag ziehen, um den Start festzulegen.</p>' +
      (unscheduled.length ? unscheduled.map(miniCard).join('') : '<p class="hint">Alle Projekte sind eingeplant.</p>') +
      '</aside>';

    var nav = '<div class="cal-nav">' +
      '<button type="button" class="btn btn-sm" data-action="cal-prev" aria-label="Vorheriger Monat">‹</button>' +
      '<h2>' + MONATE[m] + ' ' + y + '</h2>' +
      '<button type="button" class="btn btn-sm" data-action="cal-next" aria-label="Nächster Monat">›</button>' +
      '<button type="button" class="btn btn-sm" data-action="cal-today">Heute</button></div>';

    view.innerHTML = pageHead('Kalender', 'Projekte per Drag & Drop verschieben. ⚠ = Start liegt vor der Lieferung.', nav + newBtn) +
      '<div class="cal-layout">' + html + side + '</div>';
  }

  /* ---------- Routing ---------- */

  var routes = { projekte: viewProjects, kanban: viewKanban, kalender: viewCalendar, archiv: viewArchive };

  function currentRoute() {
    var r = (location.hash || '').replace(/^#\/?/, '');
    return routes[r] ? r : 'projekte';
  }

  function render() {
    var r = currentRoute();
    document.querySelectorAll('.nav a').forEach(function (a) {
      if (a.dataset.route === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    routes[r]();
  }

  /* ---------- Dialog ---------- */

  function teilRow(t) {
    t = t || { name: '', lieferzeit: '' };
    return '<div class="teil-row">' +
      '<input type="text" name="teil-name" placeholder="z. B. Schornsteinrohr" aria-label="Bauteil" value="' + esc(t.name) + '">' +
      '<input type="number" name="teil-lz" min="0" step="1" placeholder="Tage" aria-label="Lieferzeit in Tagen" value="' + esc(t.lieferzeit) + '">' +
      '<button type="button" class="btn btn-sm btn-danger" data-action="teil-remove" aria-label="Bauteil entfernen">×</button>' +
    '</div>';
  }

  function openDialog(id) {
    var p = id ? find(id) : normalize({ name: '', dauer: 1 });
    p.name = id ? p.name : '';
    dialog.dataset.id = id || '';
    dialog.innerHTML =
      '<form id="projectForm" autocomplete="off">' +
      '<div class="dlg-head"><h2 id="dialogTitle">' + (id ? 'Projekt bearbeiten' : 'Neues Projekt') + '</h2></div>' +
      '<div class="dlg-body">' +
        '<div class="full"><label for="f-name">Projektname *</label><input id="f-name" name="name" required maxlength="120" value="' + esc(p.name) + '"></div>' +
        '<div><label for="f-kunde">Kunde</label><input id="f-kunde" name="kunde" maxlength="120" value="' + esc(p.kunde) + '"></div>' +
        '<div><label for="f-ort">Ort der Baustelle</label><input id="f-ort" name="ort" maxlength="120" value="' + esc(p.ort) + '"></div>' +
        '<div><label for="f-status">Status</label><select id="f-status" name="status">' +
          STATUS.map(function (s) { return '<option value="' + s.key + '"' + (p.status === s.key ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') +
        '</select></div>' +
        '<div><label for="f-dauer">Dauer (Kalendertage)</label><input id="f-dauer" name="dauer" type="number" min="1" step="1" value="' + p.dauer + '"></div>' +
        '<div><label for="f-bestell">Bestelldatum</label><input id="f-bestell" name="bestelldatum" type="date" value="' + esc(p.bestelldatum) + '"></div>' +
        '<div><label for="f-start">Starttermin</label><input id="f-start" name="start" type="date" value="' + esc(p.start) + '"></div>' +
        '<div class="full"><label>Bauteile &amp; Lieferzeiten</label>' +
          '<div class="teile" id="teile">' +
            '<div class="teil-head"><span>Bauteil</span><span>Lieferzeit (Tage)</span><span></span></div>' +
            p.teile.map(teilRow).join('') +
          '</div>' +
          '<button type="button" class="btn btn-sm" data-action="teil-add">+ Bauteil hinzufügen</button>' +
        '</div>' +
        '<div class="full calc-box" id="calcBox"></div>' +
        '<div class="full"><label for="f-notiz">Notiz</label><textarea id="f-notiz" name="notiz" maxlength="2000">' + esc(p.notiz) + '</textarea></div>' +
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
    var names = f.querySelectorAll('[name="teil-name"]');
    var lz = f.querySelectorAll('[name="teil-lz"]');
    var teile = [];
    names.forEach(function (n, i) {
      var name = n.value.trim();
      if (name) teile.push({ name: name, lieferzeit: Math.max(0, parseInt(lz[i].value, 10) || 0) });
    });
    var el = f.elements;
    return {
      name: el.name.value.trim(),
      kunde: el.kunde.value.trim(),
      ort: el.ort.value.trim(),
      status: el.status.value,
      dauer: Math.max(1, parseInt(el.dauer.value, 10) || 1),
      bestelldatum: el.bestelldatum.value,
      start: el.start.value,
      notiz: el.notiz.value,
      teile: teile
    };
  }

  function updateCalc() {
    var box = $('#calcBox');
    if (!box) return;
    var data = normalize(readForm());
    var e = earliestStart(data);
    if (!e) {
      box.innerHTML = '<span>Noch keine Bauteile erfasst – der früheste Starttermin kann nicht berechnet werden.</span>';
      return;
    }
    var max = Math.max.apply(null, data.teile.map(function (t) { return t.lieferzeit; }));
    var base = data.bestelldatum ? 'Bestelldatum' : 'heute';
    var warn = data.start && data.start < e;
    box.innerHTML = '<span>Längste Lieferzeit: <strong>' + max + ' Tage</strong> ab ' + base +
      ' → frühester Start: <strong>' + fmt(e) + '</strong>' +
      (warn ? ' <span class="hint-warn">⚠ Gewählter Start liegt davor</span>' : '') + '</span>' +
      '<button type="button" class="btn btn-sm" data-action="apply-earliest" data-date="' + e + '">Als Start übernehmen</button>';
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
    var blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), projects: projects }, null, 2)],
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
    var d = new Date(ui.cal.y, ui.cal.m + delta, 1);
    ui.cal = { y: d.getFullYear(), m: d.getMonth() };
    render();
  }

  var actions = {
    'new': function () { openDialog(null); },
    'edit': function (el) { openDialog(el.dataset.id); },
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
    'cal-today': function () { var n = new Date(); ui.cal = { y: n.getFullYear(), m: n.getMonth() }; render(); },
    'dlg-cancel': function () { dialog.close(); },
    'teil-add': function () {
      $('#teile').insertAdjacentHTML('beforeend', teilRow());
      var rows = $('#teile').querySelectorAll('[name="teil-name"]');
      rows[rows.length - 1].focus();
    },
    'teil-remove': function (el) { el.closest('.teil-row').remove(); updateCalc(); },
    'apply-earliest': function (el) { $('#f-start').value = el.dataset.date; updateCalc(); }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.dataset.action];
    if (fn) fn(el);
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'searchBox') { ui.q = e.target.value; renderProjectList(); }
    else if (e.target.closest && e.target.closest('#projectForm')) updateCalc();
  });

  document.addEventListener('change', function (e) {
    if (e.target.id === 'sortSel') { ui.sort = e.target.value; renderProjectList(); }
    else if (e.target.closest && e.target.closest('#projectForm')) updateCalc();
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
    drag = { id: el.dataset.dragId, day: el.dataset.dragDay || null };
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
      } else if (t.dataset.dropDay) {
        p.start = (drag.day && p.start) ? addDays(p.start, diffDays(drag.day, t.dataset.dropDay)) : t.dataset.dropDay;
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
