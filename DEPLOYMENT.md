# Vercel deployment

TRIDAVO uses Express for its API and serves the existing static UI. Vercel runs the Express app as a Node.js function; PostgreSQL stores application data and sessions because function filesystems are not persistent.

## Set up the database

Create a PostgreSQL database on Neon and copy its pooled connection string. Before migrating, use a fresh/empty database or branch so existing records are not overwritten or assigned conflicting IDs.

To migrate an existing local SQLite database, install `psql` and Python 3, then run these commands from the repository root. Keep the connection string in the environment, not in source control:

```sh
export DATABASE_URL='postgresql://...'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
python3 database/export_sqlite.py database/tridavo.db | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

The exporter reads the ignored local `database/tridavo.db`, writes inserts in foreign-key order, and advances PostgreSQL sequences. It does not modify or delete the SQLite file. If no local data needs to be retained, the first application request creates the PostgreSQL tables from `database/schema.sql`.

## Configure Vercel

Set the project root to the repository root, choose the Other framework preset, select Node.js 22, leave the output directory unset, and use:

- Install command: `npm install`
- Build command: `npm run build`

Add these environment variables in Project Settings > Environment Variables:

- `DATABASE_URL`: Neon pooled PostgreSQL connection string. Enable it for Production and for Preview/Development environments where the app should connect to a database.
- `SESSION_SECRET`: a long random secret, separately configured for each environment. Generate one locally with `openssl rand -base64 32` and enter it directly in Vercel.
- `NODE_ENV`: Vercel sets this for deployments; do not override it unless needed.

Redeploy after setting the variables. Vercel routes API requests to `api/index.js` and serves the existing `public` UI and root stylesheet.

## Local commands

```sh
npm install
npm run build
npm start
```

The local server requires `DATABASE_URL`; set `SESSION_SECRET` locally when testing production cookie behavior. No automated test or lint script currently exists; `npm run build` runs JavaScript syntax checks.
