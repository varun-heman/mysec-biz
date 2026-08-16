# Sauron

Map and database of Bengaluru apartment societies, built to find and size
prospects for mySecurity.

## Run it

```bash
python3 -m http.server 8788 --directory Sauron
```

Then open http://localhost:8788/web/index.html

Leaflet on CARTO basemaps, no API key. The city dropdown holds Bangalore only
for now, and the layer dropdown carries the live count of what is on screen.

Colour, type and components come from the website's `assets/css/tokens.css` and
from `Research/viewer`, so the three read as one product. Dark by default, with
a toggle that remembers.

## The map

Clusters carry two numbers: how many societies, and how many flats between them.
Click one to zoom into it, or zoom in past 14 for society outlines. The grey line
is the Greater Bengaluru boundary, derived from the ward polygons. The globe
button switches to satellite imagery. Map credits fold into the (i) in the
corner.

The bar across the top of the map is a faceted search. Type part of a name to
jump to a society, or type a field name (`builder`, `ward`, `corporation`,
`locality`, `income`, `data`) and press Tab to pivot on it. Then pick a value and
press Tab again: it becomes a chip, the count updates, and the list underneath
shows the societies behind it. Chips stack, so builder then ward then income all
narrow together. Backspace on an empty box drops the last one.

Clicking a society opens its profile: the map moves to one side, everything known
about that society sits on the other, and only that society is outlined.

## Split

Drag the divider to change how much room the map gets. The button in the header
switches between a top and bottom split and a left and right one. Both are
remembered.

## The table

Columns behave the way a spreadsheet does.

- **Sort**: click a heading to cycle ascending, descending, then back to the
  file's own order, which is largest estimated society first.
- **Filter**: the row of boxes under the headings filters that column. Text
  columns match on substring. Numeric columns take `>500`, `<=200`, `150-400` or
  a plain number.
- **Resize**: drag the right edge of any heading. Widths are remembered.

Above the table: a search across name, builder, locality and ward, a minimum
unit count, and a corporation filter for the five GBA corporations.

## Layout

```
Sauron/
  web/            static front end, no build step
  data/           generated datasets, one JSON per stage
  scrape/         numbered pipeline scripts, each writes to data/
  SOURCES.md      where every field comes from, and what has not been run yet
```

## Rebuild the data

```bash
node Sauron/scrape/01-osm-candidates.js   # raw OSM polygons
node Sauron/scrape/02-gba-wards.js        # 369 GBA wards, police, fire, hospitals
node Sauron/scrape/03-societies.js        # classify, name builders, estimate units
node Sauron/scrape/04-boundary.js         # the city outline, from the ward edges
node Sauron/scrape/05-rera.js             # Karnataka RERA, names normalised
node Sauron/scrape/14-nominatim.js        # locality, street, postcode where still blank
```

Overpass responses are cached in `data/.cache-*.json`. Delete a cache file to
force a fresh pull. Step 3 depends on the output of steps 1 and 2.

## Imagery

```bash
node Sauron/scrape/06-images.js --min-units 150
```

Free and keyless. Two aerials per society from Esri World Imagery, one framed on
the society and one pulled back, plus any Wikimedia Commons photograph that is
actually of the place. Five files at most, saved under
`web/assets/img/societies/<slug>/` with `index.json` alongside. Resumable, so it
can be run in batches, and `--refresh` redoes ones already done.

## What the badges mean

`sourced` is a unit count from a real source. `estimated` is derived from
building footprints and floor counts, shown with a tilde, and carries a range in
the cell tooltip. `spatial` means the society is on the map but nothing about its
size is known yet. Read `SOURCES.md` before adding a field. Nothing gets a value
without a source.
