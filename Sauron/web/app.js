/* Sauron: map and society table. Data comes from ../data/societies.json.
   Palette, type and components follow the site's tokens.css, the icon sprite is
   the site's own, and the layout idiom follows Research/viewer, so a move
   between the three does not feel like a move between products. */

const CITIES = {
  bengaluru: {
    label: 'Bangalore',
    centre: [12.9716, 77.5946],
    zoom: 11,
    bounds: [[12.72, 77.35], [13.20, 77.85]],
    data: '../data/societies.json',
  },
};

/** Below this zoom the map shows counts, above it, outlines. */
const OUTLINE_ZOOM = 14;

let ALL = [];      // every society, file order
let TOTAL = 0;     // how many there are before any filter
let VIEW = [];     // what the table and map currently show
let selected = null;

const el = (id) => document.getElementById(id);
const root = document.documentElement;
const store = (k, v) => (v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v));

/* ----------------------------------------------------------------- icons */

/* icons.svg is the site's own sprite, with a few symbols added to its spec.
   Browsers are inconsistent about `<use href="file.svg#id">` across documents,
   so the sprite is fetched once and injected, and every `use` then resolves
   against the page itself. */
fetch('icons.svg')
  .then((r) => r.text())
  .then((svg) => {
    // Parsed as SVG, not as HTML. innerHTML in an HTML document lower cases
    // attribute names, which turns viewBox into viewbox and the symbol renders
    // as nothing.
    // The sprite's banner comments contain runs of "=" and "--", which XML
    // rejects inside a comment, so the comments go before parsing.
    const doc = new DOMParser().parseFromString(svg.replace(/<!--[\s\S]*?-->/g, ''), 'image/svg+xml');
    const sprite = document.importNode(doc.documentElement, true);
    sprite.setAttribute('style', 'display:none');
    document.body.prepend(sprite);
    document.querySelectorAll('use[href^="icons.svg#"]').forEach((u) => {
      u.setAttribute('href', u.getAttribute('href').replace('icons.svg', ''));
    });
  });

/* ----------------------------------------------------------------- theme */

root.setAttribute('data-theme', store('sauron-theme') || 'dark');

el('theme').addEventListener('click', () => {
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  store('sauron-theme', next);
  tiles();
  draw();
});

/** Read a design token, so the map never carries its own hex values. */
const token = (name) => getComputedStyle(root).getPropertyValue(name).trim();
const isDark = () => root.getAttribute('data-theme') === 'dark';

/* ----------------------------------------------------- split and resizing */

const body = document.body;
body.dataset.split = store('sauron-split') || 'cols';
let ratio = Number(store('sauron-ratio') || 50);

function layout() {
  // One society open puts the map beside its details, whichever way the list
  // was split, because reading a profile in a letterbox is no good.
  const rows = body.dataset.split === 'rows' && body.dataset.view !== 'detail';
  el('split').style.gridTemplateRows = rows ? `${ratio}fr 6px ${100 - ratio}fr` : '1fr';
  el('split').style.gridTemplateColumns = rows ? '1fr' : `${ratio}fr 6px ${100 - ratio}fr`;
  el('orient').title = rows ? 'Split left and right' : 'Split top and bottom';
  requestAnimationFrame(() => map.invalidateSize());
}

el('orient').addEventListener('click', () => {
  body.dataset.split = body.dataset.split === 'rows' ? 'cols' : 'rows';
  store('sauron-split', body.dataset.split);
  layout();
});

let dragSplit = false;
el('divider').addEventListener('mousedown', (e) => { dragSplit = true; e.preventDefault(); body.classList.add('dragging'); });

window.addEventListener('mousemove', (e) => {
  if (!dragSplit) return;
  const box = el('split').getBoundingClientRect();
  const pct = body.dataset.split === 'rows'
    ? ((e.clientY - box.top) / box.height) * 100
    : ((e.clientX - box.left) / box.width) * 100;
  ratio = Math.min(85, Math.max(15, Math.round(pct)));
  layout();
});

window.addEventListener('mouseup', () => {
  if (!dragSplit) return;
  dragSplit = false;
  body.classList.remove('dragging');
  store('sauron-ratio', ratio);
});

/* --------------------------------------------------------------- columns */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const none = '<span class="none"></span>';
const dash = (v) => (v == null || v === '' ? none : esc(v));
const tags = (list, cap = 3) =>
  !list?.length ? none
    : list.slice(0, cap).map((x) => `<span class="tag">${esc(x)}</span>`).join('') +
      (list.length > cap ? `<span class="tag">+${list.length - cap}</span>` : '');
const km = (m) => (m == null ? none : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const units = (s) => s.units_total ?? s.units_estimated?.mid ?? null;

const COLUMNS = [
  { key: 'name', label: 'Society', type: 'text', width: 210, cls: 'soc',
    value: (s) => s.name,
    cell: (s) => esc(s.name) + (s.enclaves?.length ? `<span class="tag tag--sub">+${s.enclaves.length} enclaves</span>` : '') },

  { key: 'builder', label: 'Builder', type: 'text', width: 140,
    value: (s) => s.builder || '', cell: (s) => dash(s.builder) },

  { key: 'locality', label: 'Locality', type: 'text', width: 130, cls: 'dim',
    value: (s) => s.location.locality || s.location.street || '',
    cell: (s) => dash(s.location.locality || s.location.street) },

  { key: 'ward', label: 'Ward', type: 'num', width: 150,
    value: (s) => s.ward?.ward_no ?? null,
    text: (s) => (s.ward ? `${s.ward.ward_no} ${s.ward.name}` : ''),
    cell: (s) => (s.ward
      ? `<span class="wardno" title="${esc(s.ward.corporation)} ward ${s.ward.ward_no}">` +
        `${esc(s.ward.corporation.replace('Bengaluru ', '')[0])}${s.ward.ward_no}</span> ${esc(s.ward.name)}`
      : none) },

  { key: 'corp', label: 'Corporation', type: 'text', width: 118, cls: 'dim',
    value: (s) => s.ward?.corporation || '',
    cell: (s) => dash(s.ward?.corporation?.replace('Bengaluru ', '')) },

  { key: 'plot', label: 'Plot (ac)', type: 'num', width: 82, align: 'num',
    value: (s) => s.plot?.area_acres ?? null, cell: (s) => dash(s.plot?.area_acres) },

  { key: 'units', label: 'Units (est)', type: 'num', width: 96, align: 'num',
    value: units,
    cell: (s) => (s.units_total != null ? `<b>${s.units_total}</b>`
      : s.units_estimated
        ? `<span title="range ${s.units_estimated.low} to ${s.units_estimated.high}, derived from built form">~${s.units_estimated.mid}</span>`
        : none) },

  { key: 'blocks', label: 'Blocks', type: 'num', width: 70, align: 'num',
    value: (s) => s.apartment_blocks || null, cell: (s) => dash(s.apartment_blocks || null) },

  { key: 'floors', label: 'Floors', type: 'num', width: 70, align: 'num',
    value: (s) => s.mean_levels || null, cell: (s) => dash(s.mean_levels || null) },

  { key: 'types', label: 'Unit types', type: 'text', width: 116,
    value: (s) => (s.unit_types || []).join(' '), cell: (s) => tags(s.unit_types) },

  { key: 'sqft', label: 'Avg sq ft', type: 'num', width: 86, align: 'num',
    value: (s) => s.avg_unit_sqft ?? null, cell: (s) => dash(s.avg_unit_sqft) },

  { key: 'beds', label: 'Bedroom mix', type: 'text', width: 150,
    value: (s) => Object.keys(s.units_by_bedrooms || {}).join(' '),
    cell: (s) => (s.units_by_bedrooms
      ? tags(Object.entries(s.units_by_bedrooms).map(([k, v]) => `${k} ${v}`), 4) : none) },

  { key: 'built', label: 'Built', type: 'num', width: 68, align: 'num',
    value: (s) => s.year_built ?? null, cell: (s) => dash(s.year_built) },

  { key: 'income', label: 'Income', type: 'text', width: 92, cls: 'dim',
    value: (s) => s.income_band || '', cell: (s) => dash(s.income_band) },

  { key: 'amenities', label: 'Amenities', type: 'text', width: 170,
    value: (s) => (s.amenities || []).join(' '), cell: (s) => tags(s.amenities) },

  { key: 'lights', label: 'Lights /km²', type: 'num', width: 96, align: 'num',
    value: (s) => LIGHTS[wardKey(s.ward)]?.lights_per_sqkm ?? null,
    cell: (s) => {
      const w = LIGHTS[wardKey(s.ward)];
      if (!w || w.lights_per_sqkm == null) return none;
      return `<span title="${w.lights} street lights across ${w.area_sqkm} sq km of ward ${w.ward_no}">${w.lights_per_sqkm}</span>`;
    } },

  { key: 'incidents', label: 'Incidents', type: 'num', width: 86, align: 'num',
    value: (s) => (s.incidents || []).length || null,
    cell: (s) => (s.incidents?.length ? `<span class="badge incident">${s.incidents.length}</span>` : none) },

  { key: 'police', label: 'Police', type: 'num', width: 86, align: 'num',
    value: (s) => s.nearest?.police?.distance_m ?? null,
    cell: (s) => (s.nearest?.police ? `<span title="${esc(s.nearest.police.name)}">${km(s.nearest.police.distance_m)}</span>` : none) },

  { key: 'fire', label: 'Fire', type: 'num', width: 86, align: 'num',
    value: (s) => s.nearest?.fire?.distance_m ?? null,
    cell: (s) => (s.nearest?.fire ? `<span title="${esc(s.nearest.fire.name)}">${km(s.nearest.fire.distance_m)}</span>` : none) },

  { key: 'hospital', label: 'Hospital', type: 'num', width: 86, align: 'num',
    value: (s) => s.nearest?.hospital?.distance_m ?? null,
    cell: (s) => (s.nearest?.hospital ? `<span title="${esc(s.nearest.hospital.name)}">${km(s.nearest.hospital.distance_m)}</span>` : none) },

  { key: 'data', label: 'Data', type: 'text', width: 92,
    value: (s) => (s.units_total != null ? 'sourced' : s.units_estimated ? 'estimated' : 'spatial'),
    cell: (s) => {
      const k = s.units_total != null ? 'enriched' : s.units_estimated ? 'estimated' : 'spatial';
      return `<span class="badge ${k}">${k === 'enriched' ? 'sourced' : k}</span>`;
    } },
];

const byKey = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));

const widths = JSON.parse(store('sauron-widths') || '{}');
COLUMNS.forEach((c) => { if (widths[c.key]) c.width = widths[c.key]; });

let sort = JSON.parse(store('sauron-sort') || 'null');
const colFilters = {};

/* ------------------------------------------------------------------- map */

/* SVG rather than canvas, so the glow filter in the stylesheet can reach the
   shapes. At this many polygons the difference in speed is not noticeable. */
const map = L.map('map', {
  zoomControl: true, preferCanvas: false, attributionControl: false,
  // Everything glides. Nothing in this map should jump cut.
  zoomAnimation: true, markerZoomAnimation: true, fadeAnimation: true,
  zoomSnap: 0.25, zoomDelta: 0.5, wheelDebounceTime: 24, wheelPxPerZoomLevel: 90,
  inertia: true, inertiaDeceleration: 2400, easeLinearity: 0.22,
});

/** One easing for every camera move, so the map has a single sense of weight. */
const GLIDE = { duration: 1.1, easeLinearity: 0.22 };
const glideTo = (latlng, zoom) => map.flyTo(latlng, zoom, GLIDE);
const glideBounds = (bounds, padding = [60, 60]) =>
  map.flyToBounds(bounds, padding
    ? { ...GLIDE, padding }
    : {
        ...GLIDE,
        // Room for the command bar above and for the hover card below.
        paddingTopLeft: [50, 100],
        paddingBottomRight: [50, 200],
        maxZoom: 17,
      });
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

/* The tile licences require credit, so it cannot simply be deleted. It is
   folded into an (i) that opens on hover, which is what map products do when
   the corner is needed for something else. */
const credit = L.control({ position: 'bottomright' });
credit.onAdd = () => {
  const d = L.DomUtil.create('div', 'credit');
  d.innerHTML =
    `<button type="button" aria-label="Map credits"><svg class="ic"><use href="#icon-info"/></svg></button>` +
    `<span>Leaflet &middot; &copy; OpenStreetMap contributors &middot; &copy; CARTO &middot; Esri</span>`;
  L.DomEvent.disableClickPropagation(d);
  return d;
};
credit.addTo(map);

let tileLayer = null;
let satellite = false;

/** CARTO for the dark base, Esri World Imagery when the eye icon is on. */
function tiles() {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = satellite
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, className: 'tiles tiles--sat',
      })
    : L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isDark() ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, {
        maxZoom: 20, className: 'tiles', subdomains: 'abcd',
      });
  tileLayer.addTo(map);
  tileLayer.bringToBack();
}
tiles();

const satBtn = L.control({ position: 'topleft' });
satBtn.onAdd = () => {
  const d = L.DomUtil.create('div', 'leaflet-bar satbtn');
  d.innerHTML = `<a href="#" data-label="Satellite imagery"><svg class="ic"><use href="#icon-eye"/></svg></a>`;
  L.DomEvent.on(d, 'click', (e) => {
    L.DomEvent.stop(e);
    satellite = !satellite;
    d.classList.toggle('on', satellite);
    if (satellite) hideSpotlight();
    tiles();
    if (!satellite && selected) showSpotlight(ALL.find((x) => x.id === selected));
  });
  return d;
};
satBtn.addTo(map);

const shapes = L.layerGroup().addTo(map);

/* ------------------------------------------------- satellite through a hole */

/* A second tile layer of satellite imagery, in its own pane between the base
   tiles and the vector overlay, clipped to the selected society's outline. The
   city stays dark and schematic and only the one site shows as real ground.
   The clip is written in layer point space, the same space the pane's tiles
   live in, so it stays put while panning and scales with a zoom animation. */
map.createPane('spotlight');
map.getPane('spotlight').style.zIndex = 250;
map.getPane('spotlight').style.pointerEvents = 'none';

let spotlight = null;
let spotFor = null;

function clipSpotlight(polygon) {
  const pane = map.getPane('spotlight');
  const points = polygon.map((p) => map.latLngToLayerPoint(L.latLng(p[0], p[1])));
  pane.style.clipPath = `polygon(${points.map((pt) => `${pt.x}px ${pt.y}px`).join(',')})`;
}

function showSpotlight(society) {
  if (!society?.polygon || society.polygon.length < 3) return hideSpotlight();
  if (!spotlight) {
    spotlight = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, pane: 'spotlight', className: 'tiles--sat' }
    );
  }
  if (!map.hasLayer(spotlight)) spotlight.addTo(map);
  spotFor = society;
  clipSpotlight(society.polygon);
}

function hideSpotlight() {
  spotFor = null;
  if (spotlight && map.hasLayer(spotlight)) map.removeLayer(spotlight);
  map.getPane('spotlight').style.clipPath = '';
}

// Leaflet moves the layer origin on zoom and on reset, so the clip is redrawn.
map.on('zoomend viewreset moveend', () => { if (spotFor) clipSpotlight(spotFor.polygon); });

/* The Greater Bengaluru outline, so it is obvious what the map covers. Derived
   from the 369 ward polygons, which tile the city exactly. */
const cityLine = L.layerGroup().addTo(map);

fetch('../data/gba-boundary.json', { cache: 'no-store' })
  .then((r) => r.json())
  .then(({ rings }) => {
    // Grey, not accent. It is the edge of the working area, not a finding.
    for (const ring of rings) {
      cityLine.addLayer(L.polyline(ring, {
        color: token('--boundary'), weight: 1.4, opacity: 0.7,
        interactive: false, className: 'cityline',
      }));
    }
  })
  .catch(() => {});

const clusters = L.markerClusterGroup({
  chunkedLoading: true,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  animate: true,
  animateAddingMarkers: false,
  spiderfyDistanceMultiplier: 1.4,
  maxClusterRadius: (z) => (z < 12 ? 90 : z < 14 ? 60 : 40),
  disableClusteringAtZoom: 16,
  iconCreateFunction(cluster) {
    const kids = cluster.getAllChildMarkers();
    const n = kids.length;
    const flats = kids.reduce((s, m) => s + (m.options.units || 0), 0);
    // Big enough that both numbers are readable, not just present.
    const size = n < 10 ? 38 : n < 50 ? 46 : n < 200 ? 56 : 66;
    const short = flats > 1000 ? `${Math.round(flats / 1000)}k` : flats;
    return L.divIcon({
      className: 'cl',
      iconSize: [size, size],
      html:
        `<div class="cl__ring" style="--s:${size}px"` +
        ` title="${n} societies, about ${flats.toLocaleString('en-IN')} flats between them">` +
        `<b>${n}</b></div>` +
        // The flats figure is wider than the circle at every size, so it hangs
        // under it on a pill rather than spilling over the edge.
        (flats ? `<span class="cl__flats">${short} flats</span>` : ''),
    });
  },
}).addTo(map);

// zoomToBounds snaps. Flying to the same bounds keeps the sense of travel.
clusters.on('clusterclick', (e) => glideBounds(e.layer.getBounds()));

/* ------------------------------------------------------------------ heat */

/* Road crashes per traffic police jurisdiction. It is the only official figure
   published below city level, and it is road safety rather than crime, which
   the legend says out loud. */
const heat = L.layerGroup();
let heatOn = false;

function heatColour(v, max) {
  const t = Math.min(1, Math.sqrt(v / (max || 1)));       // sqrt, or the tail hides everything
  const hue = 48 - 48 * t;                                 // amber to red
  return `hsl(${hue}, ${55 + 35 * t}%, ${58 - 26 * t}%)`;
}

function drawHeat() {
  heat.clearLayers();
  const values = CRASHES.map((j) => j.fatal_per_sqkm).filter((v) => v != null);
  if (!values.length) return;
  const max = Math.max(...values);

  for (const j of CRASHES) {
    if (!j.polygon?.length) continue;
    const known = j.fatal_per_sqkm != null;
    heat.addLayer(L.polygon(j.polygon, {
      color: known ? heatColour(j.fatal_per_sqkm, max) : '#666',
      weight: 1,
      fillColor: known ? heatColour(j.fatal_per_sqkm, max) : '#666',
      fillOpacity: known ? 0.42 : 0.06,
      className: 'heat',
    }).bindTooltip(
      `<b>${esc(j.station)}</b><em>road crashes, ${j.latest_year || 'no year'}</em>` +
      `<div class="tip__grid">` +
      `<span><i>Crashes</i>${j.total_crashes ?? '-'}</span>` +
      `<span><i>Deaths</i>${j.fatal_crashes ?? '-'}</span>` +
      `<span><i>Area</i>${j.area_sqkm} km²</span>` +
      `<span><i>Deaths /km²</i>${j.fatal_per_sqkm ?? '-'}</span></div>`,
      { className: 'tip', sticky: true }
    ));
  }
}

const heatBtn = L.control({ position: 'topleft' });
heatBtn.onAdd = () => {
  const d = L.DomUtil.create('div', 'leaflet-bar satbtn');
  d.innerHTML = `<a href="#" data-label="Road crashes by jurisdiction"><svg class="ic"><use href="#icon-car-crash"/></svg></a>`;
  L.DomEvent.on(d, 'click', (e) => {
    L.DomEvent.stop(e);
    heatOn = !heatOn;
    d.classList.toggle('on', heatOn);
    if (heatOn) { drawHeat(); heat.addTo(map); heat.eachLayer((l) => l.bringToBack()); }
    else map.removeLayer(heat);
    el('heatNote').textContent = heatOn ? 'shading: road deaths per km², latest year' : '';
  });
  return d;
};
heatBtn.addTo(map);

/* ------------------------------------------------------------------ load */

async function loadCity(key) {
  const c = CITIES[key];
  map.setView(c.centre, c.zoom, { animate: false });
  map.setMaxBounds(L.latLngBounds(c.bounds).pad(0.4));
  requestAnimationFrame(() => map.invalidateSize());

  try {
    const res = await fetch(c.data, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    // Enclaves live inside a larger society, so they are not drawn or counted
    // separately. They stay reachable through their parent's row.
    const all = json.societies || [];
    ALL = all.filter((s) => !s.part_of);
    // The enclaves are filtered out of the list and the map, but their records
    // are what make the enclave strip on a profile clickable.
    PARTS = {};
    for (const s of all) {
      if (!s.part_of) continue;
      (PARTS[s.part_of] ||= []).push(s);
    }
    TOTAL = ALL.length;
  } catch (err) {
    ALL = [];
    console.warn('no dataset yet:', err.message);
  }
  header();
  apply();
}

/* --------------------------------------------------- faceted command bar */

/** The fields the command bar can pivot on. `values` builds the list of
 *  suggestions, each with the number of societies behind it. */
const FACETS = [
  { key: 'builder', label: 'builder', of: (s) => s.builder },
  { key: 'corporation', label: 'corporation', of: (s) => s.ward?.corporation },
  { key: 'ward', label: 'ward', of: (s) => (s.ward ? `${s.ward.ward_no} ${s.ward.name}` : null) },
  { key: 'locality', label: 'locality', of: (s) => s.location.locality },
  { key: 'income', label: 'income', of: (s) => s.income_band },
  { key: 'data', label: 'data', of: (s) => (s.units_total != null ? 'sourced' : s.units_estimated ? 'estimated' : 'spatial') },
];

const facetByKey = Object.fromEntries(FACETS.map((f) => [f.key, f]));

let chips = [];        // [{key, value}]
let pending = null;    // facet key awaiting a value
let cursor = 0;        // highlighted suggestion
let suggestions = [];

const omni = el('omniInput');

/** Societies that survive the chips already applied. */
function chipped(list = ALL) {
  return list.filter((s) => chips.every((c) => facetByKey[c.key].of(s) === c.value));
}

function buildSuggestions() {
  const q = omni.value.trim().toLowerCase();

  if (pending) {
    const f = facetByKey[pending];
    const tally = new Map();
    for (const s of chipped()) {
      const v = f.of(s);
      if (v == null || v === '') continue;
      tally.set(v, (tally.get(v) || 0) + 1);
    }
    return [...tally.entries()]
      .filter(([v]) => v.toLowerCase().includes(q))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([value, n]) => ({ kind: 'value', key: pending, value, n }));
  }

  const out = [];
  const pool = chipped();

  // Fields still worth pivoting on. One already pinned, or one with a single
  // value left, is not worth offering again.
  const pivots = FACETS
    .filter((f) => !chips.some((c) => c.key === f.key))
    .filter((f) => !q || f.label.startsWith(q))
    .map((f) => ({ kind: 'facet', key: f.key, value: f.label, n: new Set(pool.map((s) => f.of(s)).filter(Boolean)).size }))
    .filter((f) => f.n > 1);

  const hits = [];
  if (chips.length || q) {
    for (const s of pool) {
      if (hits.length > 60) break;
      if (!q) { hits.push({ kind: 'society', society: s, value: s.name, n: units(s) }); continue; }
      const hay = `${s.name} ${s.builder || ''} ${s.location.locality || ''}`.toLowerCase();
      if (hay.includes(q)) hits.push({ kind: 'society', society: s, value: s.name, n: units(s) });
    }
  }

  // Typing a field name means the field, not the societies whose promoter
  // happens to contain the word "builders". Anything else means the societies,
  // with the pivots underneath so another filter is always one Tab away.
  const namingAField = q && FACETS.some((f) => f.label.startsWith(q));
  return namingAField ? [...pivots, ...hits] : [...hits, ...pivots];
}

function renderOmni() {
  el('chips').innerHTML =
    chips.map((c, i) =>
      `<span class="chip" data-chip="${i}">${esc(c.key)}<b>${esc(c.value)}</b>
        <svg class="ic"><use href="icons.svg#icon-close"/></svg></span>`).join('') +
    (pending ? `<span class="chip chip--pending">${esc(pending)}<b>&hellip;</b></span>` : '');

  const list = el('omniList');
  suggestions = buildSuggestions();
  cursor = Math.min(cursor, suggestions.length - 1);

  if (!suggestions.length) { list.hidden = true; return; }
  list.hidden = false;
  list.innerHTML = suggestions.slice(0, 40).map((s, i) => {
    const icon = s.kind === 'facet' ? 'icon-filter' : s.kind === 'society' ? 'icon-building' : 'icon-check';
    const meta = s.kind === 'society'
      ? (s.n ? `${s.n} units` : '')
      : `${s.n} to choose from`;
    return `<li class="${i === cursor ? 'on' : ''}" data-i="${i}">
      <svg class="ic"><use href="#${icon}"/></svg>
      <span class="om-label">${esc(s.value)}</span>
      <span class="om-meta">${esc(meta)}</span>
      ${i === cursor ? '<kbd>tab</kbd>' : ''}
    </li>`;
  }).join('');

  el('omniHint').textContent = pending
    ? `Pick a ${pending}, or backspace to go back`
    : chips.length
      ? `${VIEW.length} match. Tab a field below to narrow further, backspace to drop the last filter`
      : 'Tab to pivot on a field, Enter to open a society';
}

/** Move the highlight without rebuilding the list, and keep it on screen. */
function markCursor(scroll = false) {
  const list = el('omniList');
  [...list.children].forEach((li, i) => {
    const on = i === cursor;
    li.classList.toggle('on', on);
    const kbd = li.querySelector('kbd');
    if (on && !kbd) li.insertAdjacentHTML('beforeend', '<kbd>tab</kbd>');
    if (!on && kbd) kbd.remove();
    if (on && scroll) li.scrollIntoView({ block: 'nearest' });
  });
}

function accept(i = cursor) {
  const s = suggestions[i];
  if (!s) return;
  if (s.kind === 'facet') { pending = s.key; omni.value = ''; }
  else if (s.kind === 'value') { chips.push({ key: s.key, value: s.value }); pending = null; omni.value = ''; }
  else { select(s.society.id); omni.value = ''; }
  cursor = 0;
  renderOmni();
  apply();
}

omni.addEventListener('input', () => { cursor = 0; renderOmni(); });
omni.addEventListener('focus', renderOmni);

omni.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); accept(); }
  else if (e.key === 'Enter') { e.preventDefault(); accept(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, suggestions.length - 1); markCursor(true); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); markCursor(true); }
  else if (e.key === 'Backspace' && !omni.value) {
    if (pending) pending = null;
    else chips.pop();
    renderOmni(); apply();
  } else if (e.key === 'Escape') { el('omniList').hidden = true; omni.blur(); }
});

el('omniList').addEventListener('mousemove', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li || Number(li.dataset.i) === cursor) return;
  cursor = Number(li.dataset.i);
  markCursor();
});

el('omniList').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); accept(Number(li.dataset.i)); }
});

el('chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip]');
  if (!chip) return;
  chips.splice(Number(chip.dataset.chip), 1);
  renderOmni(); apply();
});

el('omniClear').addEventListener('click', () => {
  chips = []; pending = null; omni.value = ''; selected = null;
  renderOmni(); apply();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.omni')) el('omniList').hidden = true;
});

/* --------------------------------------------------------------- filters */

/** Numeric filter language: "500", ">500", "<=200", "100-500". */
function numMatch(expr, v) {
  const q = expr.trim();
  if (!q) return true;
  if (v == null) return false;
  let m;
  if ((m = q.match(/^(>=|<=|>|<)\s*(-?[\d.]+)$/))) {
    const n = Number(m[2]);
    return m[1] === '>' ? v > n : m[1] === '<' ? v < n : m[1] === '>=' ? v >= n : v <= n;
  }
  if ((m = q.match(/^(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)$/))) return v >= Number(m[1]) && v <= Number(m[2]);
  if ((m = q.match(/^=?\s*(-?[\d.]+)$/))) return v === Number(m[1]);
  return String(v).includes(q);
}

function apply() {
  const minUnits = +el('minUnits').value;
  const corp = el('corp').value;
  const incidentsOnly = el('incidentsOnly').checked;
  const free = pending ? '' : omni.value.trim().toLowerCase();

  VIEW = ALL.filter((s) => {
    if (!chips.every((c) => facetByKey[c.key].of(s) === c.value)) return false;
    if (free) {
      const hay = `${s.name} ${s.builder || ''} ${s.location.locality || ''} ${s.ward?.name || ''}`.toLowerCase();
      if (!hay.includes(free)) return false;
    }
    if (minUnits && !(units(s) >= minUnits)) return false;
    if (corp && s.ward?.corporation !== corp) return false;
    if (incidentsOnly && !(s.incidents || []).length) return false;

    for (const [key, expr] of Object.entries(colFilters)) {
      if (!expr) continue;
      const c = byKey[key];
      const v = c.type === 'num' ? c.value(s) : (c.text ? c.text(s) : c.value(s));
      const ok = c.type === 'num' ? numMatch(expr, v)
        : String(v).toLowerCase().includes(expr.toLowerCase());
      if (!ok) return false;
    }
    return true;
  });

  if (sort) {
    const c = byKey[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    VIEW.sort((a, b) => {
      const av = c.value(a), bv = c.value(b);
      if (av == null || av === '') return bv == null || bv === '' ? 0 : 1;
      if (bv == null || bv === '') return -1;
      return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * dir;
    });
  }

  // The count lives in the layer dropdown's label, not in a separate readout.
  el('layer').options[0].textContent = `${VIEW.length.toLocaleString('en-IN')} societies`;
  el('mapCount').textContent = VIEW.length.toLocaleString('en-IN');

  // And the line under the filters describes the current selection, rather than
  // repeating a number from the file that never moves.
  const sourced = VIEW.filter((s) => s.units_total != null).length;
  const guessed = VIEW.filter((s) => s.units_total == null && s.units_estimated).length;
  const flats = VIEW.reduce((n, s) => n + (units(s) || 0), 0);
  el('provenance').textContent = VIEW.length === TOTAL
    ? `all ${TOTAL.toLocaleString('en-IN')} societies, ${sourced} with a sourced unit count, ${guessed} estimated`
    : `${VIEW.length.toLocaleString('en-IN')} of ${TOTAL.toLocaleString('en-IN')} societies, `
      + `${flats.toLocaleString('en-IN')} flats, ${sourced} sourced and ${guessed} estimated`;
  draw();
  render();
}

/** The hover card: enough to decide whether to open the society. */
function summary(s) {
  const u = units(s);
  const line = (k, v) => (v == null || v === '' ? '' : `<span><i>${k}</i>${v}</span>`);
  // A strip of thumbnails across the top, so the card answers "what is this
  // place" before you read a single number.
  const pics = (IMAGES[s.id]?.files || []).slice(0, 6);
  return (pics.length
      ? `<div class="tip__shots">${pics.map((p) => `<img src="${esc(p)}" alt="" loading="lazy" />`).join('')}</div>`
      : '') +
    `<b>${esc(s.name)}</b>` +
    (s.builder ? `<em>${esc(s.builder)}</em>` : '') +
    `<div class="tip__grid">` +
      line('Units', u == null ? null : `${s.units_total == null ? '~' : ''}${u}`) +
      line('Plot', s.plot ? `${s.plot.area_acres} ac` : null) +
      line('Towers', s.towers ?? (s.apartment_blocks || null)) +
      line('Built', s.year_built) +
      line('Ward', s.ward ? `${s.ward.ward_no} ${s.ward.name}` : null) +
      line('Police', s.nearest?.police ? km(s.nearest.police.distance_m) : null) +
    `</div>` +
    `<button type="button" class="tip__go" data-go="${esc(s.id)}">Show details</button>`;
}

/* The card is a normal element over the map, so the pointer can leave the dot,
   travel to it and press the button. A short grace period covers the gap. */
const card = el('hover');
let cardFor = null;
let cardTimer = null;
let cardAnchor = null;

function placeCard() {
  if (!cardAnchor) return;
  const p = map.latLngToContainerPoint(cardAnchor);
  const box = el('map').getBoundingClientRect();
  const w = card.offsetWidth || 224;
  const h = card.offsetHeight || 198;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // Above the dot if it fits, below if that fits, and beside it when the map
  // pane is too short for either, which it often is once the table has room.
  let left = clamp(p.x - w / 2, 8, box.width - w - 8);
  let top;
  let mode = 'above';

  if (p.y - h - 14 >= 8) top = p.y - h - 14;
  else if (p.y + 16 + h <= box.height - 8) { top = p.y + 16; mode = 'below'; }
  else {
    mode = 'side';
    top = clamp(p.y - h / 2, 8, Math.max(8, box.height - h - 8));
    left = p.x + 18 + w <= box.width - 8 ? p.x + 18 : clamp(p.x - w - 18, 8, box.width - w - 8);
  }

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.classList.toggle('below', mode === 'below');
  card.classList.toggle('beside', mode === 'side');
}

function showCard(s, marker) {
  clearTimeout(cardTimer);
  if (cardFor !== s.id) {
    card.innerHTML = summary(s);
    cardFor = s.id;
  }
  cardAnchor = marker.getLatLng();
  card.hidden = false;
  placeCard();
  requestAnimationFrame(() => card.classList.add('on'));
}

function hideCard(delay = 260) {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    card.classList.remove('on');
    cardFor = null;
    cardAnchor = null;
    setTimeout(() => { if (!cardFor) card.hidden = true; }, 160);
  }, delay);
}

card.addEventListener('mouseenter', () => clearTimeout(cardTimer));
card.addEventListener('mouseleave', () => hideCard(120));
card.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (!go) return;
  hideCard(0);
  select(go.dataset.go);
});

map.on('move zoom', placeCard);

/* ---------------------------------------------------------------- shapes */

const markers = new Map(); // society id -> marker

function draw() {
  const accent = token('--accent');
  const plain = token('--muted');

  clusters.clearLayers();
  markers.clear();
  shapes.clearLayers();

  const batch = [];
  for (const s of VIEW) {
    const known = units(s) != null;
    const m = L.circleMarker([s.location.lat, s.location.lon], {
      radius: known ? 6 : 4,
      color: known ? accent : plain,
      weight: 1.5,
      fillColor: known ? accent : plain,
      fillOpacity: known ? 0.85 : 0.4,
      className: 'pin',
      units: units(s) || 0,
    });
    m.on('mouseover', () => {
      // Pins are SVG paths, so their stacking is document order: bring the
      // hovered one to the front rather than leaving it under its neighbour.
      if (m.bringToFront) m.bringToFront();
      showCard(s, m);
    });
    m.on('mouseout', () => hideCard());
    m.on('click', () => select(s.id, false));
    m._sid = s.id;
    markers.set(s.id, m);
    batch.push(m);
  }
  clusters.addLayers(batch);

  outlines();
  highlight();
}

/** Outlines are noise at city zoom and the point of the map up close. When one
 *  society is selected it is the only one drawn, which is what selection means. */
function outlines() {
  shapes.clearLayers();
  const z = map.getZoom();
  const accent = token('--accent');

  if (selected) {
    const s = ALL.find((x) => x.id === selected);
    showSpotlight(s);
    if (s?.polygon?.length > 2) {
      // No fill: the satellite pane underneath is the fill now. The stroke is
      // all that is needed to read the boundary.
      shapes.addLayer(L.polygon(s.polygon, {
        color: accent, weight: 2.5, fill: false,
        className: 'shape shape--on', interactive: false,
      }));
    }
    el('zoomNote').textContent = s ? s.name : '';
    return;
  }

  hideSpotlight();

  if (z < OUTLINE_ZOOM) {
    el('zoomNote').textContent = `zoom in for outlines`;
    return;
  }

  const bounds = map.getBounds();
  let n = 0;
  for (const s of VIEW) {
    if (n > 400) break;
    if (!s.polygon?.length || !bounds.contains([s.location.lat, s.location.lon])) continue;
    shapes.addLayer(L.polygon(s.polygon, {
      color: accent, weight: 1.4, fillColor: accent, fillOpacity: 0.1,
      className: 'shape', interactive: false,
    }));
    n++;
  }
  el('zoomNote').textContent = n ? `${n} outlines` : '';
}

map.on('zoomend moveend', outlines);

/* ------------------------------------------------------ selection marker */

/* A polygon outline is not enough to answer "which one am I looking at",
 * especially when the society has no shape or sits inside a cluster. The
 * selected society gets a pulsing ring and its name pinned to the map. */
const halo = L.layerGroup().addTo(map);

function highlight() {
  halo.clearLayers();
  document.querySelectorAll('.pin--on').forEach((n) => n.classList.remove('pin--on'));
  if (!selected) return;

  const s = ALL.find((x) => x.id === selected);
  if (!s?.location) return;
  const at = [s.location.lat, s.location.lon];

  halo.addLayer(L.marker(at, {
    interactive: false,
    keyboard: false,
    zIndexOffset: 1000,
    icon: L.divIcon({
      className: 'selmark',
      iconSize: [0, 0],
      html: '<span class="selmark__pulse"></span><span class="selmark__ring"></span>' +
            `<span class="selmark__label">${esc(s.name)}</span>`,
    }),
  }));

  const m = markers.get(selected);
  if (m?._path) m._path.classList.add('pin--on');
}

/* ----------------------------------------------------------------- table */

function sizeTable() {
  el('tbl').style.width = `${COLUMNS.reduce((s, c) => s + c.width, 0)}px`;
}

function header() {
  el('head').innerHTML =
    `<tr class="hrow">${COLUMNS.map((c) => {
      const dir = sort?.key === c.key ? sort.dir : '';
      return `<th data-key="${c.key}" style="width:${c.width}px"
                  class="${c.align === 'num' ? 'num' : ''}${dir ? ' sorted' : ''}">
        <span class="th-in"><span class="th-label">${esc(c.label)}</span>
        <svg class="ic th-sort ${dir}"><use href="#icon-sort${dir ? `-${dir}` : ''}"/></svg></span>
        <span class="th-grip" data-grip="${c.key}"></span></th>`;
    }).join('')}</tr>` +
    `<tr class="frow">${COLUMNS.map((c) =>
      `<th style="width:${c.width}px"><input class="cf" data-cf="${c.key}" type="text"
         value="${esc(colFilters[c.key] || '')}"
         placeholder="${c.type === 'num' ? '>150' : 'filter'}" /></th>`).join('')}</tr>`;
  sizeTable();
}

function render() {
  const tbody = el('rows');
  if (!VIEW.length) {
    tbody.innerHTML =
      `<tr><td colspan="${COLUMNS.length}" class="empty">Nothing matches. Clear a filter, or the dataset has not been built yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = VIEW.slice(0, 600).map((s) =>
    `<tr data-id="${esc(s.id)}"${s.id === selected ? ' class="on"' : ''}>` +
    COLUMNS.map((c) =>
      `<td class="${[c.cls, c.align === 'num' ? 'num' : ''].filter(Boolean).join(' ')}"
           style="width:${c.width}px">${c.cell(s)}</td>`).join('') + `</tr>`
  ).join('');
}

function select(id, fly = true) {
  selected = id;
  render();
  outlines();
  highlight();
  const s = ALL.find((x) => x.id === id);
  if (!s) return;
  openDetail(s);

  const m = markers.get(id);
  // The panel opening resizes the map, and a resize mid flight kills the
  // animation, so the resize happens first and the camera leaves on the next
  // frame. Without this the map appears to teleport.
  requestAnimationFrame(() => {
    map.invalidateSize({ pan: false });
    requestAnimationFrame(() => {
      if (fly) frameSociety(s);
      map.once('moveend', () => {
        if (m) clusters.zoomToShowLayer(m, () => showCard(s, m));
      });
    });
  });
  const row = document.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/**
 * Put the whole society on screen rather than dropping the camera on its centre
 * at a fixed zoom. The padding keeps the site clear of the command bar above
 * and of its own card below.
 */
function frameSociety(s) {
  if (s.polygon?.length > 2) return glideBounds(L.latLngBounds(s.polygon), null);
  return glideTo([s.location.lat, s.location.lon], Math.max(map.getZoom(), 16));
}

/* ------------------------------------------------------------ detail view */

/* Society imagery, fetched ahead of time by scrape/06-images.js into
   web/assets/img/societies/: a site aerial, a context aerial, and any Wikimedia
   Commons photograph that is actually of the place. Five at most each, and
   nothing is fetched while the page is open. */
let IMAGES = {};
let LIGHTS = {};   // corporation and ward number -> street lighting for that ward
let CRASHES = [];  // traffic police jurisdictions, with their crash series
let PARTS = {};    // parent society id -> the enclaves inside it
let NEWS = { societies: {}, builders: {} }; // scrape/13-news.js: society id and builder name -> articles

/* GBA ward numbers restart in each of the five corporations, so ward 49 exists
   five times over. Anything keyed on the number alone silently collides. */
const wardKey = (w) => (w ? `${(w.corporation || '').replace('Bengaluru ', '')}#${w.ward_no}` : null);
fetch('../data/road-crashes.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : { jurisdictions: [] }))
  .then((j) => { CRASHES = j.jurisdictions || []; if (heatOn) drawHeat(); })
  .catch(() => {});

fetch('../data/streetlights.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : { wards: [] }))
  .then((j) => {
    LIGHTS = Object.fromEntries((j.wards || []).map((w) => [wardKey(w), w]));
    apply();
  })
  .catch(() => {});

fetch('assets/img/societies/index.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).then((j) => { IMAGES = j || {}; }).catch(() => {});

fetch('../data/news.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { if (j) NEWS = j; })
  .catch(() => {});

const newsDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const NEWS_CATEGORY = { crime: 'Crime', accident: 'Accident', award: 'Award', legal: 'Legal', civic: 'Civic' };

function newsList(articles) {
  if (!articles?.length) return '';
  return `<ul class="news">${articles.map((a) => `
    <li>
      <a class="news__item" href="${esc(a.link)}" target="_blank" rel="noopener">
        ${a.image
          ? `<img class="news__thumb" src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
          : `<span class="news__thumb news__thumb--empty"><svg class="ic"><use href="icons.svg#icon-alert"/></svg></span>`}
        <span class="news__body">
          <span class="news__title">${esc(a.title)}</span>
          <span class="news__meta">
            <span class="news__dot${a.reviewed ? '' : ' unread'}" title="${a.reviewed ? 'reviewed' : 'not yet reviewed'}"></span>
            ${a.category ? `<span class="news__cat news__cat--${esc(a.category)}">${esc(NEWS_CATEGORY[a.category] || a.category)}</span>` : ''}
            <span>${esc(a.source || 'unknown source')}${newsDate(a.published_at) ? ` &middot; ${newsDate(a.published_at)}` : ''}</span>
          </span>
        </span>
      </a>
    </li>`).join('')}</ul>`;
}

// og:image links can 404 or block hotlinking; fall back to the placeholder
// rather than showing a broken image icon.
el('detailBody').addEventListener('error', (e) => {
  if (e.target.matches?.('.news__thumb')) {
    e.target.outerHTML = '<span class="news__thumb news__thumb--empty"><svg class="ic"><use href="icons.svg#icon-alert"/></svg></span>';
  }
}, true);

const stat = (label, value, hint) =>
  `<div class="stat"${hint ? ` title="${esc(hint)}"` : ''}>
     <span class="stat__k">${esc(label)}</span>
     <span class="stat__v">${value == null || value === '' ? '<i class="none"></i>' : value}</span>
   </div>`;

function openDetail(s) {
  body.dataset.view = 'detail';
  el('detail').hidden = false;
  layout();

  const u = s.units_total ?? s.units_estimated?.mid;
  const r = s.rera;
  const shot = IMAGES[s.id] || null;
  const photos = shot?.files || [];
  const creditFor = (f) => (shot?.credits || []).find((c) => c.file === f) || {};
  shots = photos.map((f) => ({ file: f, society: s.name, ...creditFor(f) }));

  el('detailBody').innerHTML = `
    <h2 class="detail__name">${esc(s.name)}</h2>
    <p class="detail__sub">
      ${s.builder ? `<span class="tag">${esc(s.builder)}</span>` : ''}
      ${s.ward ? `<span class="tag"><i class="tag__k">Ward</i><b class="wardno">${esc(s.ward.corporation.replace('Bengaluru ', '')[0])}${s.ward.ward_no}</b> ${esc(s.ward.name)}</span>` : ''}
      ${s.ward ? `<span class="tag">${esc(s.ward.corporation)}</span>` : ''}
      <span class="badge ${s.units_total != null ? 'enriched' : s.units_estimated ? 'estimated' : 'spatial'}">
        ${s.units_total != null ? 'sourced' : s.units_estimated ? 'estimated' : 'spatial'}</span>
    </p>

    ${photos.length ? `<div class="shots">${photos.map((p, i) =>
      `<img src="${esc(p)}" data-i="${i}" alt="${esc(s.name)}" loading="lazy" />`).join('')}</div>
      <p class="shots__by">${photos.length} images</p>` : ''}

    <div class="stats">
      ${stat('Units', s.units_total != null ? `<b>${s.units_total}</b>`
        : s.units_estimated ? `~${s.units_estimated.mid}` : null,
        s.units_estimated && s.units_total == null ? `range ${s.units_estimated.low} to ${s.units_estimated.high}` : '')}
      ${stat('Plot', s.plot ? `${s.plot.area_acres} acres` : null, s.plot?.source)}
      ${stat('Towers', s.towers ?? (s.apartment_blocks || null))}
      ${stat('Floors', s.mean_levels || null, 'mean, from OSM building tags')}
      ${stat('Built', s.year_built)}
      ${stat('Avg unit', s.avg_unit_sqft ? `${s.avg_unit_sqft} sq ft` : null)}
      ${stat('Income band', s.income_band)}
      ${stat('Assembly', s.ward?.assembly)}
      ${stat('Road deaths', (() => {
        const t = s.traffic_jurisdiction;
        if (!t) return null;
        if (t.fatal_crashes == null) return `<em>${esc(t.station)}, no figures published</em>`;
        return `${t.fatal_crashes} <em>in ${esc(t.station)}, ${t.latest_year}, from ${t.total_crashes} crashes</em>`;
      })(), 'Bengaluru Traffic Police, station wise. Road safety, not crime.')}
      ${stat('Street lights', (() => {
        const w = LIGHTS[wardKey(s.ward)];
        if (!w) return null;
        if (w.lights_per_sqkm == null) return '<em>outside the counted area</em>';
        return `${w.lights_per_sqkm} <em>per sq km, ${w.lights.toLocaleString('en-IN')} in the ward</em>`;
      })(), 'BBMP count, moved onto the new ward map by area')}
    </div>

    <h3>Emergency response</h3>
    <div class="stats stats--wide">
      ${['police', 'fire', 'hospital'].map((k) => stat(
        k[0].toUpperCase() + k.slice(1),
        s.nearest?.[k] ? `${km(s.nearest[k].distance_m)} <em>${esc(s.nearest[k].name)}</em>` : null
      )).join('')}
    </div>

    ${r ? `<h3>RERA filing</h3>
    <div class="stats stats--wide">
      ${stat('Registration', r.reg_number)}
      ${stat('Status', r.status)}
      ${stat('Promoter', r.promoter)}
      ${stat('Registered', r.registered)}
      ${stat('Completion', r.completion)}
      ${stat('Towers', r.towers)}
      ${stat('Land area', r.land_area_sqm ? `${(r.land_area_sqm / 4046.86).toFixed(2)} acres` : null)}
      ${stat('Covered area', r.covered_area_sqm ? `${Math.round(r.covered_area_sqm).toLocaleString('en-IN')} sq m` : null)}
      ${stat('FAR', r.far)}
      ${stat('Parking', r.parking_covered || r.parking_open
        ? `${(r.parking_covered || 0) + (r.parking_open || 0)}` : null, 'covered plus open')}
      ${stat('Fire fighting', r.fire_fighting)}
      ${stat('Project cost', r.project_cost_inr ? `₹${(r.project_cost_inr / 1e7).toFixed(1)} cr` : null)}
    </div>` : ''}

    ${s.enclaves?.length ? `<h3>Enclaves <b>${s.enclaves.length}</b></h3>
      <div class="enclaves">${(PARTS[s.id] || s.enclaves.map((n) => ({ name: n }))).map((e) => {
        // Every enclave repeats its township's name, so it is dropped: nine
        // rows of "Adarsh Palm Retreat ..." says nothing nine times.
        const short = e.name.replace(s.name, '').replace(/^[\s-]+/, '') || e.name;
        const u = e.units_total ?? e.units_estimated?.mid;
        return `<button type="button" class="enclave" ${e.id ? `data-enclave="${esc(e.id)}"` : ''}>
          <span>${esc(short)}</span>${u ? `<i>${u}</i>` : ''}</button>`;
      }).join('')}</div>` : ''}

    ${s.location.address_full ? `<h3>Address</h3>
      <div class="addr">
        <p class="addr__text">${esc(s.location.address_full)}</p>
        <a class="addr__maps" href="https://www.google.com/maps/search/?api=1&query=${s.location.lat},${s.location.lon}"
           target="_blank" rel="noopener" title="Open in Google Maps">
          <svg class="ic"><use href="icons.svg#icon-pin"/></svg> Maps
        </a>
      </div>` : ''}

    ${(() => {
      const societyNews = NEWS.societies?.[s.id]?.articles || [];
      const seen = new Set(societyNews.map((a) => a.link));
      const builderNews = s.builder ? (NEWS.builders?.[s.builder]?.articles || []).filter((a) => !seen.has(a.link)) : [];
      if (!societyNews.length && !builderNews.length) {
        return `<h3>News</h3><p class="detail__note">Nothing found for this society or its builder yet.</p>`;
      }
      return `
        <h3>News <b>${societyNews.length}</b></h3>
        ${societyNews.length ? newsList(societyNews)
          : '<p class="detail__note">Nothing found for this society by name yet.</p>'}
        <p class="detail__note">Matched by name against the query, not a confirmed identification &mdash;
          <span class="news__dot unread" style="display:inline-block;vertical-align:middle"></span> marks anything not yet read.</p>
        ${builderNews.length ? `<h3>${esc(s.builder)} news <b>${builderNews.length}</b></h3>${newsList(builderNews)}` : ''}
      `;
    })()}

  `;
}

function closeDetail() {
  body.dataset.view = 'list';
  el('detail').hidden = true;
  selected = null;
  render();
  outlines();
  layout();
}

/* ------------------------------------------------------------- lightbox */

let shots = [];      // the open society's images
let shotAt = 0;

function showShot(i) {
  if (!shots.length) return;
  shotAt = (i + shots.length) % shots.length;
  const s = shots[shotAt];
  el('lbImg').src = s.file;
  // Just the name and the position. Source and licence live in the profile's
  // Sources list and in the map credit, so they do not need repeating here.
  el('lbCap').innerHTML =
    `<b>${esc(s.society)}</b><span>${shotAt + 1} of ${shots.length}</span>` +
    (s.page ? ` <a href="${esc(s.page)}" target="_blank" rel="noopener">source</a>` : '');
  el('lightbox').hidden = false;
  requestAnimationFrame(() => el('lightbox').classList.add('on'));
}

function closeShot() {
  el('lightbox').classList.remove('on');
  setTimeout(() => { el('lightbox').hidden = true; el('lbImg').src = ''; }, 180);
}

el('lbClose').addEventListener('click', closeShot);
el('lbPrev').addEventListener('click', () => showShot(shotAt - 1));
el('lbNext').addEventListener('click', () => showShot(shotAt + 1));
el('lightbox').addEventListener('click', (e) => {
  // Clicking the backdrop closes. Clicking the picture or a control does not.
  if (e.target === el('lightbox') || e.target.closest('.lb__frame') === el('lbImg').parentElement && e.target.tagName === 'FIGURE') closeShot();
});
window.addEventListener('keydown', (e) => {
  if (el('lightbox').hidden) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeShot(); }
  if (e.key === 'ArrowRight') showShot(shotAt + 1);
  if (e.key === 'ArrowLeft') showShot(shotAt - 1);
});

const enclaveLayer = L.layerGroup().addTo(map);

el('detailBody').addEventListener('mouseover', (e) => {
  const chip = e.target.closest('[data-enclave]');
  enclaveLayer.clearLayers();
  if (!chip) return;
  const part = Object.values(PARTS).flat().find((p) => p.id === chip.dataset.enclave);
  if (!part?.polygon?.length) return;
  enclaveLayer.addLayer(L.polygon(part.polygon, {
    color: token('--accent'), weight: 2, dashArray: '4 3',
    fillColor: token('--accent'), fillOpacity: 0.25, interactive: false, className: 'shape',
  }));
});

el('detailBody').addEventListener('mouseleave', () => enclaveLayer.clearLayers());

el('detailBody').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-enclave]');
  if (chip) {
    const part = Object.values(PARTS).flat().find((p) => p.id === chip.dataset.enclave);
    if (part?.polygon?.length > 2) glideBounds(L.latLngBounds(part.polygon), [60, 60]);
    else if (part) glideTo([part.location.lat, part.location.lon], 17);
    return;
  }
  const img = e.target.closest('.shots img');
  // A drag across the strip should scroll it, not open the picture it ended on.
  if (!img || strip.moved) return;
  showShot(Number(img.dataset.i) || 0);
});

/* Drag to scroll the strip, and let a vertical wheel move it sideways, which is
   what a trackpad swipe does on a horizontal list. */
const strip = { el: null, down: false, startX: 0, startScroll: 0, moved: false };

el('detailBody').addEventListener('mousedown', (e) => {
  const row = e.target.closest('.shots');
  if (!row) return;
  Object.assign(strip, { el: row, down: true, startX: e.pageX, startScroll: row.scrollLeft, moved: false });
  row.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!strip.down) return;
  const dx = e.pageX - strip.startX;
  if (Math.abs(dx) > 4) strip.moved = true;
  strip.el.scrollLeft = strip.startScroll - dx;
});

window.addEventListener('mouseup', () => {
  if (!strip.down) return;
  strip.down = false;
  strip.el.classList.remove('dragging');
  setTimeout(() => { strip.moved = false; }, 0);
});

el('detailBody').addEventListener('wheel', (e) => {
  const row = e.target.closest('.shots');
  if (!row || row.scrollWidth <= row.clientWidth) return;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  row.scrollLeft += e.deltaY;
}, { passive: false });

el('detailBack').addEventListener('click', closeDetail);
el('detailClose').addEventListener('click', closeDetail);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && body.dataset.view === 'detail' && document.activeElement !== omni) closeDetail();
});

/* ------------------------------------------------- header: sort and size */

el('head').addEventListener('click', (e) => {
  if (e.target.closest('.th-grip') || e.target.closest('input')) return;
  const th = e.target.closest('th[data-key]');
  if (!th) return;
  const key = th.dataset.key;
  sort = !sort || sort.key !== key ? { key, dir: 'asc' }
       : sort.dir === 'asc' ? { key, dir: 'desc' } : null;
  store('sauron-sort', JSON.stringify(sort));
  header();
  apply();
});

el('head').addEventListener('input', (e) => {
  const input = e.target.closest('input[data-cf]');
  if (!input) return;
  colFilters[input.dataset.cf] = input.value;
  apply();
});

let drag = null;

el('head').addEventListener('mousedown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (!grip) return;
  e.preventDefault();
  const c = byKey[grip.dataset.grip];
  drag = { c, startX: e.clientX, startW: c.width };
  body.classList.add('resizing');
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  drag.c.width = Math.max(56, Math.round(drag.startW + (e.clientX - drag.startX)));
  const i = COLUMNS.indexOf(drag.c) + 1;
  document.querySelectorAll(`th[data-key="${drag.c.key}"], .frow th:nth-child(${i}), #rows td:nth-child(${i})`)
    .forEach((cell) => { cell.style.width = `${drag.c.width}px`; });
  sizeTable();
});

window.addEventListener('mouseup', () => {
  if (!drag) return;
  widths[drag.c.key] = drag.c.width;
  store('sauron-widths', JSON.stringify(widths));
  drag = null;
  body.classList.remove('resizing');
});

/* ---------------------------------------------------------------- wiring */

['minUnits', 'corp', 'incidentsOnly'].forEach((id) => el(id).addEventListener('input', apply));

function resetFilters() {
  el('minUnits').value = '0';
  el('corp').value = '';
  el('incidentsOnly').checked = false;
  Object.keys(colFilters).forEach((k) => delete colFilters[k]);
  chips = []; pending = null; omni.value = ''; selected = null;
  sort = null;
  localStorage.removeItem('sauron-sort');
  header(); renderOmni(); apply();
}

el('reset').addEventListener('click', resetFilters);

/* The logo is the "start over" control: same filter reset as the Reset
 * button, plus everything Reset leaves alone because it is a view rather
 * than a filter: an open profile, the satellite and crash layers, and
 * wherever the map has been panned or zoomed to. */
el('brand').addEventListener('click', () => {
  if (!el('detail').hidden) closeDetail();
  for (const label of ['Satellite imagery', 'Road crashes by jurisdiction']) {
    const a = document.querySelector(`a[data-label="${label}"]`);
    if (a?.closest('.satbtn')?.classList.contains('on')) a.click();
  }
  resetFilters();
  loadCity('bengaluru');
});

el('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) select(tr.dataset.id);
});

el('city').addEventListener('change', (e) => loadCity(e.target.value));
window.addEventListener('resize', () => map.invalidateSize());

layout();
renderOmni();
loadCity('bengaluru');
