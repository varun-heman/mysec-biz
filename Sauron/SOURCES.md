# Sauron: data sources

Target: every Bengaluru apartment society, with the metadata needed to size a
security deployment and find the buying committee. No unit floor is applied
anywhere in the pipeline: a 20 unit complex is as much a customer as a 2,000
unit township, it just needs a smaller deployment. `150 units or more` still
shows up as a badge and a default table sort, since that is the segment worth
looking at first, not as a cutoff for what gets collected.

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
name, which adds 185 societies mapped as a single building or a point rather
than as a landuse polygon.

**Estimates units.** Built area is footprint area times floor count for every
OSM building inside the polygon, times 0.82 for circulation, divided by 130 sq m
per dwelling. The range uses 165 and 105 sq m as the bounds. This is derived,
carries its inputs, and is shown in the table with a tilde and an `estimated`
badge. It is not a fact and is never presented as one. No size floor is
applied: a society estimated well under 150 units is kept, not dropped.

**Result before RERA: 1,120 societies, 390 of them estimated at 150 units or
more, and 340 with the unit count unknown rather than estimated (no built
form for OSM to measure).**

### 4. Karnataka RERA, through a mirror

rera.karnataka.gov.in does not answer from this network at all: no ping, no
HTTP, TLS reset by the host, with and without the sandbox and through a browser.
So the register is read from
[github.com/Vonter/karnataka-rera-projects](https://github.com/Vonter/karnataka-rera-projects),
which scrapes the portal into 8,791 projects and 174 columns and publishes them
under ODbL.

Bengaluru Urban and Rural only, residential project types only, which leaves
3,331 of the 8,791. Of those, 248 matched a society we already had and 1,163
were added as societies in their own right: every filing with a coordinate,
whatever its unit count says, is in. RERA supplies promoter, registration
number and status, unit count, tower count, land and covered area, FAR,
parking, completion date, project cost and fire fighting status.

A filing lands inside a GBA ward polygon, or it does not: 603 of the 1,163
added this way sit outside every ward but within 15 km of the notified
boundary, which is Sarjapur, Attibele and Anekal outskirts carrying real
Bengaluru launches that the March 2026 notification simply does not reach yet.
Those get the nearest ward instead of no ward, flagged `ward.approx: true` so
its police, fire and hospital distances are read as approximate. Only 30
filings, further than that, are a different city and stay out.

It only covers registrations from 2017 onward, so older societies still depend
on the built form estimate.

`scrape/05-rera.js`.

### 5. City outline

`scrape/04-boundary.js` derives the Greater Bengaluru outline from the ward
polygons: an edge shared by two wards is interior, an edge that appears once is
on the outside. Runs are chained only through points where exactly two boundary
edges meet, so nothing is ever joined across a junction.

### 6. Nominatim, for the localities OSM and RERA left blank

OSM's `addr:suburb` and `addr:neighbourhood` tags, plus RERA's project taluk,
cover locality for a minority of societies; most have a GPS point and nothing
to say where it was. `scrape/14-nominatim.js` reverse geocodes each one,
one request a second per Nominatim's usage policy, and takes the first of
neighbourhood, quarter, suburb, residential or city district that is not just
the society's own name echoed back. Suburb in this data is usually the GBA
ward name, which in Bengaluru also works as the everyday locality name (Gunjur,
Hoodi, Varthur), so it is a reasonable fallback once the finer grained fields
are ruled out.

Only fills a null: nothing here overwrites a value OSM or RERA already
supplied. Street, postcode and full address are filled the same way where they
were also missing. Result: every society in the file carries a locality.
Every response is cached in `data/.cache-nominatim.json`, so a rerun only
fetches what a future OSM or RERA join has not already covered.

### 7. News, per society and per builder

`scrape/13-news.js`. Three free, keyless sources can be queried for every
society name and every builder name, each scoped to Bengaluru. Bing News RSS is
the daily primary source, GDELT 2.0 is the fallback, and Google News RSS remains
available for manual comparison.

None of the sources knows what a society or a builder is. The scraper accepts a
result only when the exact entity name is visible in the headline or RSS
snippet, and stores which field matched. Known generic collisions such as
"Aura" and "Adarsh Nagar" are suppressed at society level. Every retained
article stores its publisher, date, direct link and exact query, and remains
`reviewed: false` until a person reads it.

Builder news is queried once per builder (about 260 of them) and shared across
every society that builder built, rather than repeated per society. Results
land in `data/news.json`, keyed by society id and by builder name.

The GitHub Actions workflow runs Bing daily at 07:05 IST and falls back to
GDELT only if Bing is unavailable. Rerunning merges new articles while keeping
existing review state. A manual all-source pass takes a couple of hours because
of GDELT's five-second throttle, so it can be split into batches:

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

## Known coverage gap

OSM knows the large, older, well mapped societies well and the newer ones
poorly. Prestige returns 122 societies and Sobha 100, but Shapoorji Pallonji
returns one and SNR one. RERA's no-floor join now closes most of that gap by
name rather than by polygon, which is why Godrej went from 5 to 20, but a
builder RERA has not filed under recently is still thin. That residual gap is
exactly what licensed data or a portal partnership buys. It is not a bug in
the pipeline.

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
