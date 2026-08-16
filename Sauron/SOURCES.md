# Sauron: data sources

Target: every Bengaluru apartment society with 150 units or more, with the
metadata needed to size a security deployment and find the buying committee.

## What has run

### 1. OpenStreetMap, via Overpass. Free, ODbL, no scraping restriction

One query returns 5,102 named residential and apartment polygons inside the
Bengaluru boundary. Filtered to one acre or more, 1,797 remain. It gives name,
GPS, polygon, computed plot area, street and postcode where mapped, and floor
count on about a third of apartment buildings. `scrape/01-osm-candidates.js`.

### 2. Greater Bengaluru Authority wards. Official, public domain

369 wards with ward number, name in English and Kannada, which of the five
corporations runs it, and the assembly constituency. Boundaries come from the
Government of Karnataka final ward notification of 7 March 2026, published by
OpenCity as public domain:
https://data.opencity.in/dataset/gba-ward-wise-reservations-2026

The ward split matches the notification as reported: West 112, North 72, South
72, Central 63, East 50.

Each ward is joined to the police stations, fire stations and hospitals inside
it, and the three nearest of each kind outside it, from OSM. Current counts:
1,250 hospitals, 160 police stations, 29 fire stations. OSM police and fire
coverage is decent but not complete, so cross check against the Bengaluru City
Police and Karnataka Fire and Emergency Services station lists before relying on
response distances. `scrape/02-gba-wards.js`.

### 3. Classification, builder naming and unit estimation

`scrape/03-societies.js` does three things.

**Throws out what is not a society.** 161 government and institutional entries
(reserve police quarters, HAL and ITI colonies, railway and defence housing, BDA
and KHB blocks, Kendriya Vihar, Jal Vayu) and 23 BBMP layouts named as stages and
blocks. A further 678 polygons had no vertical built form, no builder and no
apartment tagging, so they are neighbourhoods rather than societies.

**Names the builder.** A dictionary of about 90 Bengaluru developers is matched
against the society name, and a second Overpass pass searches OSM by builder
name, which adds 276 societies mapped as a single building or a point rather
than as a landuse polygon.

**Estimates units.** Built area is footprint area times floor count for every
OSM building inside the polygon, times 0.82 for circulation, divided by 130 sq m
per dwelling. The range uses 165 and 105 sq m as the bounds. This is derived,
carries its inputs, and is shown in the table with a tilde and an `estimated`
badge. It is not a fact and is never presented as one.

**Result after RERA: 1,083 societies, 591 of them at 150 units or more, and 319
with a unit count from a real source rather than an estimate.**

### 4. Karnataka RERA, through a mirror

rera.karnataka.gov.in does not answer from this network at all: no ping, no
HTTP, TLS reset by the host, with and without the sandbox and through a browser.
So the register is read from
[github.com/Vonter/karnataka-rera-projects](https://github.com/Vonter/karnataka-rera-projects),
which scrapes the portal into 8,791 projects and 174 columns and publishes them
under ODbL.

Bengaluru Urban and Rural only, residential project types only, which leaves
3,331 of the 8,791. Of those, 214 matched a society we already had and 190 were
added as societies in their own right, inside the GBA boundary. RERA supplies
promoter, registration number and status, unit count, tower count, land and
covered area, FAR, parking, completion date, project cost and fire fighting
status.

It only covers registrations from 2017 onward, so older societies still depend
on the built form estimate.

`scrape/05-rera.js`.

### 5. City outline

`scrape/04-boundary.js` derives the Greater Bengaluru outline from the ward
polygons: an edge shared by two wards is interior, an edge that appears once is
on the outside. Runs are chained only through points where exactly two boundary
edges meet, so nothing is ever joined across a junction.

## 6. News, per society and per builder

`scrape/13-news.js`. Two free, keyless sources, queried the same way for every
society name and every builder name, each scoped to Bengaluru:
[GDELT 2.0](https://api.gdeltproject.org/api/v2/doc/doc) for full text search
back to 2017, and Google News RSS as a second opinion, since GDELT is often
unreachable or rate limited straight to a 429 in practice.

Neither source knows what a society or a builder is: it is keyword search
against a name, and "Prestige" and "Brigade" are also English words. So every
article is stored with its publisher, date, link and the exact query that
found it, marked `reviewed: false`, and stays that way until a person reads it
and says otherwise. Nothing here is a confirmed incident on its own.

Builder news is queried once per builder (about 260 of them) and shared across
every society that builder built, rather than repeated per society. Results
land in `data/news.json`, keyed by society id and by builder name.

Meant to run periodically. Rerunning merges in whatever is new; anything
already on file, and its reviewed flag, is left alone. A full pass over all
1,116 societies plus every builder is a couple of hours, almost all of it
GDELT's 5 second throttle, so split it with `--start`/`--limit` across cron
windows if that is too long in one sitting:

```bash
node Sauron/scrape/13-news.js                        # everything
node Sauron/scrape/13-news.js --start 0 --limit 400   # a batch
```

See the script's own header for the rest of the flags.

## Not yet run

| Source | Gives us | Standing |
|---|---|---|
| **Property portals** (Housing, 99acres, MagicBricks, NoBroker, CommonFloor) | Units, configurations, sizes, launch year, price per sq ft, amenities, builder, all on one page | Scraping is against their terms and they run bot protection. Needs licensed data, a portal partnership, or a small hand collected sample |
| **Licensed data** (PropEquity, Liases Foras, CRE Matrix, PropTiger) | The same fields with clean provenance and real coverage | Roughly ₹1 lakh to ₹5 lakh a year for Bengaluru |
| **Registrar of Cooperative Societies** | RWA names, registration numbers, office bearers, which is the buying committee | Partial: many apartment bodies register under the Apartment Ownership Act instead |
| **Nominatim** | Full postal address per society | 1 request a second, so about 30 minutes for the current list |

## Known coverage gap

OSM knows the large, older, well mapped societies well and the newer ones
poorly. Prestige returns 110 societies and Sobha 73, but SNR returns none,
Shapoorji Pallonji one and Godrej five. That gap is exactly what licensed data or
a portal partnership buys. It is not a bug in the pipeline.

## Society imagery

Free, no key, `scrape/06-images.js`. Up to five files per society in
`web/assets/img/societies/<slug>/`, with an index the profile reads.

1. **Site aerial**, from the Esri World Imagery export endpoint, framed on the
   society's own polygon. Keyless, and it covers every society that has a
   boundary, which is what matters: a picture for all of them beats a photograph
   for a handful.
2. **Context aerial**, the same view pulled back, so approach roads, the
   perimeter and the neighbours are visible. That is the view that sizes a
   deployment.
3. **Ground photographs from Wikimedia Commons**, found by geosearch within
   400 m and kept only when the file name or description mentions the society or
   its builder, so the lake down the road does not get attached. CC licensed,
   with author and licence recorded per file.

Coverage from the first run: two aerials for essentially every society, and a
Commons photograph for a small number. Commons simply does not have many
Bengaluru societies.

Google's listing photos are not used. That needs a billed Places key, and the
Places terms treat the photo bytes as content you may not store. The script for
it is parked at `scrape/optional/google-images.js` if you ever want it.

## Every dataset link

`data/sources.json` is the machine readable register: every URL, licence, what
it gives, which script uses it, and the ones considered and rejected with the
reason. Add a row there before adding a field to the pipeline.

## Provenance rules

Every field carries where it came from: `official`, `open`, `portal` or
`derived`. Anything unsourced stays `null` and the table draws a dash rather than
a guess.
