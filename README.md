<div align="center" style="background-color: #1a1a1a; padding: 20px; border-radius: 10px;">
  <img src="GED-eye.png" alt="GED-eye Logo" width="400">
</div>

# GED-Eye

A modern, interactive family tree viewer for GEDCOM files. Because other family tree viewers look like they're stuck in 1999.

See it live [here](https://robacourt.github.io/ged-eye) showing my family tree!

## What is this?

GedEye takes GEDCOM genealogy files and turns them into a beautiful, interactive web-based family tree visualization. Click on any person to see their immediate family - parents, spouses, and children - all rendered as an animated graph.

## Features

- 🎯 **Interactive visualization** - Click any person to make them the focus
- 🚀 **One request per person** - A Neon Function returns a person and their whole immediate family in a single call, and relatives are prefetched while you look
- 🖼️ **Photos and avatars** - Served straight from a public Neon Object Storage bucket
- 🎨 **Modern UI** - Built with Cytoscape.js for smooth graph rendering
- ⚡ **Fast** - Handles thousands of people without breaking a sweat
- 🎭 **Gender color coding** - Blue for males, pink for females
- 📊 **Relationship lines** - Visual connections between family members

## Quick Start

The front end talks to the live API and bucket, so all you need is Node:

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev

# Open http://localhost:5173/ged-eye/ in your browser
```

To build the site for GitHub Pages:

```bash
npm run build    # writes the static site to docs/
```

Commit `docs/` and merge to `main`; GitHub Pages serves it.

### Neon setup

Only needed if you're touching the backend (database, Function or bucket). Install the Neon CLI, then:

```bash
neon link        # link this folder to the GED-Eye project; writes .neon and .env.local
neon env pull    # refresh .env.local later
neon deploy      # deploy the api Function and bucket declared in neon.ts
```

### Importing the tree (one-off)

Neon is the master copy of the tree. `acourt.ged` was imported once; the steps are kept here for reference. Run them in this order:

```bash
npm run upload-media   # originals, thumbnails and avatars → ged-eye-media bucket (resumable)
npm run db:migrate     # apply db/migrations/*.sql
npm run import-ged     # load people, families and photos, and archive the GEDCOM
neon deploy            # deploy the api Function
npm run verify-neon    # parity check against the old JSON files; exits non-zero on any unexplained difference
```

- `import-ged` refuses to run if the database already has people. `npm run import-ged -- --replace --confirm <database host>` wipes and reloads everything, throwing away any edits made in Neon since.
- The old JSON files and avatars (the parity baseline) now live outside the repo in `ignore/legacy-data/`. Pass `--legacy-root ignore/legacy-data` to `upload-media`, `import-ged` and `verify-neon`.
- `scripts/generateAvatars.js` is legacy: it face-crops avatars from the old JSON files. It'll be reworked to read from Neon when editing arrives.

### Configuration

| File | Committed | What's in it |
|---|---|---|
| `.env.development`, `.env.production` | yes | `VITE_API_URL` (the Function) and `VITE_MEDIA_BASE_URL` (the bucket). Public values that end up in the JS bundle anyway. |
| `.env.local` | no | Secrets written by `neon link` / `neon env pull`: database URLs and bucket keys. |
| `.env.test.local` | no | `DATABASE_URL_TEST`, for `npm run test:db`. |
| `neon.ts` | yes | Neon resources: the `api` Function and the `ged-eye-media` bucket. |

There's deliberately no plain `.env`: the Neon CLI writes secrets into `.env` whenever that file exists.

## Project Structure

```
├── acourt.ged              # The original GEDCOM (local only; archived in Neon)
├── Data/                   # Media the GEDCOM points at (local only; uploaded to the bucket)
├── neon.ts                 # Neon resources: api Function + ged-eye-media bucket
├── api/
│   ├── index.js            # Neon Function entry: Postgres pool
│   └── handler.js          # Routes: GET /person/:id, GET /health
├── db/migrations/          # Schema and the person_view() Postgres function
├── scripts/
│   ├── gedParser.js        # GEDCOM parser
│   ├── generateAvatars.js  # Legacy avatar face-cropper (reads the old JSON)
│   └── neon/               # One-off import: upload, migrate, import, verify
├── src/
│   ├── main.js             # App entry point (DEFAULT_PERSON_ID)
│   ├── dataLoader.js       # Fetches, caches and prefetches person views
│   ├── media.js            # Bucket URLs for photos and avatars
│   ├── familyTreeView.js   # Cytoscape graph visualization
│   ├── personDetails.js    # Details panel
│   ├── photoViewer.js      # Photo viewer
│   └── style.css           # Styles
├── public/placeholders/    # Default avatars
├── docs/                   # Built site, served by GitHub Pages
└── tests/                  # Unit tests (tests/db needs a database)
```

## How it Works

1. **Data in Neon**: People, families and photo records live in Neon Postgres. The Postgres function `person_view(id)` gathers a person plus their parents, spouses, children and siblings into one JSON document.

2. **One API call per person**: The `api` Neon Function answers `GET /person/:id` by calling `person_view`. The browser caches each answer and quietly prefetches the relatives you're likely to click next.

3. **Media from a bucket**: Photos, thumbnails and face-cropped avatars sit in the public `ged-eye-media` bucket and load straight into the browser.

4. **Graph Visualization**: Cytoscape.js renders the family as a graph with the selected person in the center, parents above, children below, and spouses to the sides.

The site itself is plain static files on GitHub Pages. Neon is the master copy of the data, and the original GEDCOM is archived byte for byte in the `gedcom_archive` table, so anything the parser skips today can be recovered later.

## Tech Stack

- **Vanilla JavaScript** - No framework bloat, just modern ES6+
- **Cytoscape.js** - Graph visualization library
- **Neon** - Postgres for the tree, a Function for the API, Object Storage for photos
- **Vite** - Lightning-fast dev server and build tool
- **Vitest** - Unit testing

## Testing

```bash
npx vitest run     # unit tests (npm test runs them in watch mode)
npm run test:db    # person_view tests against a real database
```

`npm run test:db` needs `DATABASE_URL_TEST` in `.env.test.local`, pointing at a Neon branch named `test`. It wipes that branch's `public` schema on every run, and refuses to run against production.

## Changing the Default Person

Edit `DEFAULT_PERSON_ID` in `src/main.js` (it's `'I122'`). You can also link straight to anyone with `?person=I122`.

## Future Enhancements

- [ ] Smooth animations when switching between people
- [ ] Face detection and avatar extraction from photos
- [ ] Zoomed-out view showing hundreds of people at once
- [ ] Search functionality
- [ ] Info panel with detailed person information
- [ ] Export visualizations
- [ ] Editing people and photos, for signed-in family members

## Credits

Built by Rob with Claude Code. Vibes only. 🌊

## License

MIT - Do whatever you want with it
