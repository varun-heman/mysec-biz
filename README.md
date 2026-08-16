# Sauron

A map and database of Bengaluru apartment societies, built to find and size
prospects for mySecurity.

**1,083 societies.** 591 of them at 150 units or more, 319 with a unit count
from a real source rather than an estimate, all placed in one of the 369 wards
of the Greater Bengaluru Authority, each with distance to the nearest police
station, fire station and hospital.

## Run it

```bash
python3 -m http.server 8788 --directory Sauron
```

Then open http://localhost:8788/web/index.html

## Deployed

Netlify serves `Sauron` as the site root, so `/web/index.html` reaches its data
at `/data` with the same relative paths it uses locally. No build step: the
front end is plain HTML, CSS and JavaScript with a vendored copy of Leaflet.

Configuration is in [netlify.toml](netlify.toml).

## What is in here

```
Sauron/
  web/            the app, no build step
  data/           generated datasets, one JSON per stage
  scrape/         numbered pipeline scripts, each writes to data/
  SOURCES.md      where every field comes from, and what has not been run yet
  data/sources.json   every dataset link, licence and refresh note
```

The pipeline, in order:

| Step | Does |
|---|---|
| `01-osm-candidates` | Candidate societies from OpenStreetMap |
| `02-gba-wards` | 369 GBA wards, with police, fire and hospitals |
| `03-societies` | Classify, name the builder, estimate units |
| `04-boundary` | The city outline, derived from the ward edges |
| `05-rera` | Karnataka RERA register, names normalised |
| `06-images` | Site and context aerials, Wikimedia photographs |
| `08-builder-images` | Project photographs from the builder's own site |
| `09-builder-sites` | Builder to website map, from RERA filings |
| `10-clean-images` | Drop images that are site furniture, not the society |
| `11-streetlights` | BBMP street lights, moved onto the new ward map |
| `12-road-crashes` | Crashes and deaths per traffic police jurisdiction |

`07-mapillary` needs a free token and `optional/google-images.js` needs a billed
one, so neither runs by default.

## Ground rules

Every figure is either sourced or labelled an estimate with its inputs shown.
Unit counts from RERA read as plain numbers, counts derived from building
footprints and floor counts read with a tilde and carry a range. Anything
unknown stays null and the table draws a dash rather than a guess.

Read [SOURCES.md](Sauron/SOURCES.md) before adding a field.
