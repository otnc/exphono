# ExpHono

> Run your Express app on Hono. A migration-first Express compatibility layer for Node.js, Cloudflare Workers, Deno and Bun.

[![npm](https://img.shields.io/npm/v/exphono)](https://www.npmjs.com/package/exphono)
[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/otnc/exphono/ci.yml?branch=main)](https://github.com/otnc/exphono/actions)
[![GitHub](https://img.shields.io/github/license/otnc/exphono)](https://github.com/otnc/exphono/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/exphono)](https://www.npmjs.com/package/exphono)

ExpHono re-implements the Express API on top of [Hono](https://hono.dev), so an existing Express app can run unmodified on runtimes Express itself cannot reach — Cloudflare Workers, Deno and Bun — while still working on Node.js. The goal is migration, not a rewrite: keep writing `app.get(...)`, `req.query`, `res.json(...)` and the middleware you already have.

## Install

```sh
npm install exphono
```

## Usage

The default export behaves like `express()`, and `app` is still a callable function so `app.use('/sub', subApp)` and `http.createServer(app)` keep working on Node.js.

```ts
import express from 'exphono'

const app = express()

app.get('/', (req, res) => {
  res.json({ hello: 'world' })
})

app.listen(3000)
```

On Cloudflare Workers, Deno and Bun, deploy the app with `app.worker` instead of the app itself. A function default export is misread as a Durable Object class on Workers, so the export has to be a plain object:

```ts
import express from 'exphono'

const app = express()

app.get('/', (req, res) => {
  res.json({ hello: 'world' })
})

export default app.worker
```

### Pinning an Express version

Express 4 and 5 differ in a few places — the query parser, whether `req.host` strips the port, and which deprecated APIs still exist. `exphono` follows Express 5 semantics by default; import `exphono/v4` or `exphono/v5` to pin one explicitly, independent of whichever module loaded first:

```ts
import express from 'exphono/v4'
```

## Diagnostics

Anything ExpHono degrades or cannot reproduce on the current runtime is surfaced with a stable `EXPHONO_E0xx` code rather than failing silently. By default each code warns once and execution continues; enable strict mode to throw instead:

```ts
import { configure } from 'exphono'

configure({ strict: true })
```

See [docs/errors.md](./docs/errors.md) for what each code means and how to resolve it.

## Status

ExpHono is verified against the real Express test suite, not just its own tests. As of the last recorded run, it passes 996 of 1116 Express 5 tests (about 89%); the failure count is tracked as a ratchet so it can only improve. See [test/express-suite/](./test/express-suite/) for how the suite is run.

Some gaps are structural rather than missing work — anything that needs a real filesystem or a TCP listener (`app.listen()`, `res.sendFile`, on-disk view lookups) has no equivalent on Cloudflare Workers, and ExpHono reports that with a diagnostic code instead of pretending to support it.

## Requirements

- Node.js >= 20 (Node.js is not required on Bun, Deno or Workers deployments)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

Distributed under the [MIT License](./LICENSE).
