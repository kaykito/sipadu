# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Server-rendered Node.js/Express + MSSQL boilerplate (extracted from the Gov-Fina BLUD app): login with bcrypt, single-active-session per device, DB-driven menu and per-group permissions, generic `/:module/:action` dispatch, and a CRUD module generator. Application text, comments, and UI are in Indonesian.

## Commands

```bash
npm install
npm run dev                   # nodemon
npm start                     # production
npm run build                 # node --check over all server JS (no bundler/transpiler)
npm run db:migrate            # apply pending migrations/*.sql (tracked in SchemaMigrations)
npm run db:migrate:baseline   # mark current migrations as applied without running them
npm run db:seed               # apply pending seeders/*.sql (tracked in SchemaSeeders)
npm run db:seed:baseline      # mark current seeders as applied without running them
npm run db:setup              # db:migrate then db:seed
npm run generate:tables:db    # dump CREATE TABLE SQL from the live DB into migrations/tables/
```

Requires Node.js 24 (`.nvmrc`, `engines` in package.json); after switching Node versions run `npm rebuild` (bcrypt is native). There is no test suite or lint config. Always run `npm run build` after editing server JS.

Setup: copy `.env.example` to `.env`, fill DB/session values, run `npm run db:setup`. Default login after seeding: `admin` / `admin123`.

## Architecture

### Request pipeline (`app.js` + `router.js`)

`app.js` wires, in order: a hand-rolled per-IP rate limiter/bot-probe blocker, CORS, body parsing, a 403 for direct `.html` requests, static files from `public/`, session (Sequelize store, `Sessions` table, auto-synced), flash, `middleware/resetMenuSession.js` (clears non-whitelisted session keys when switching modules), a middleware that queries `FITUR`/`OTORISASI` every request to build `req.session.menuArray` / `req.session.aksesMenu`, a user-refresh middleware, `res.locals` setup, a `res.render` override that resolves bare view names against `modules/<moduleFromURL>/views/`, then `router.js`.

`router.js`: explicit routes `/`, `/login`, `/login/process` (behind `middleware/verifyTurnstile.js`); everything else is **generic dynamic dispatch**:

- `GET /:module` → `controller.index`
- `GET|POST|PUT|DELETE /:module/:action[/:id]` → `controller[action]`

All dynamic routes require `auth.check_login` + `auth.check_session_valid`. Controller path is `modules/<module>/controllers/<module>.js`. An action must be in `EXACT_DYNAMIC_ACTIONS` or match a prefix in `DYNAMIC_ACTION_PREFIXES`, and must **not** be in `DENIED_DYNAMIC_ACTIONS` — otherwise it 404s even if the handler exists. Keep the deny list as a guard for any future handler that touches the shell/server.

### Modules

```
modules/<name>/
├── controllers/<name>.js   # one exported function per action
└── views/*.html            # EJS (app.engine('html', ejs.renderFile))
```

Controllers call `database.js` directly (no ORM for business tables). Conventions:
- Gate every action with `checkAccess(req, '<aksi>')` from `helpers/accessControl.js`; aksi values are `view`, `add`, `edit`, `delete`, `validasi`, `export` (see otorisasi view). `checkAccess` derives the module key from `req.path`'s first segment, matched against the module segment of `FITUR.url`.
- Render the bare view for XHR, or wrap with `res.render('index', { content: '<module>/views/vw_data.html', ... })` for full page loads.
- `modules/contoh/` is the reference CRUD module (server-side DataTables with paging/search/order done in SQL).
- `modules/generateModule/` writes new module folders from a table schema; disabled when `NODE_ENV=production` unless `GENERATOR_ENABLED=true`. Its action is `buildModule` (`generate` is on the deny list).

### Database

`database.js` exposes two connections to the same MSSQL server:
- `sql` / `poolPromise` (`mssql`) — all business queries. Always parameterize: `pool.request().input(name, sql.Type, value).query(...)`.
- `sequelize` — only the session store. `DB_SEQUELIZE_*` default to `DB_*`; keep them on the same DB because `login.js` and `userProfile.logoutDevice` read/delete `Sessions` rows.

Core tables: `KELOMPOK` (groups), `APPUSER`, `FITUR` (menu tree via `parentKeyFITUR`, ordered by `kdFITUR`, `url` stored without leading slash), `OTORISASI` (keyFITUR × keyKLP × aksi), `USER_DEVICES`, plus `CONTOH` for the example module.

`scripts/migrate.js` applies `migrations/*.sql` (schema; top level only, not `migrations/tables/`) tracked in `SchemaMigrations`, or with `--seed` applies `seeders/*.sql` (data: core seed, FITUR/OTORISASI menu rows; integration data comes only from the SIM RS API, no sample seeder) tracked in `SchemaSeeders`. Files run in filename order, batches split on standalone `GO` lines. Seeders run after migrations and must be idempotent (`IF NOT EXISTS`). Name new files with a date prefix so they sort after existing ones.

### Auth & sessions (`auth.js`, `modules/login`)

Login accepts bcrypt hashes and, for backward compatibility, plaintext-equal passwords (marked TODO in `login.js`). On success it destroys the user's other sessions, stores `user_id`, `user`, `keyKLP`, `nmKLP`, `ketUSER`, `avatar` in the session, and records the device in `USER_DEVICES`. `auth.check_session_valid` destroys the session if its ID is no longer an active row in `USER_DEVICES`. User create/update (`modules/user`) always stores bcrypt hashes.

Turnstile is enabled automatically when both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set; `TURNSTILE_ENABLED` overrides.
