# Diagnostic codes

ExpHono reports anything it degrades or cannot reproduce on the current runtime with a stable code rather than failing silently. By default each code warns once per process and execution continues; enable strict mode with `configure({ strict: true })` to throw an `ExpHonoError` instead.

## EXPHONO_E001 — app.listen() is not available on this runtime

This runtime does not expose a TCP listener; it invokes your default export instead.

**Fix:** export default app.worker;

## EXPHONO_E002 — View could not be resolved

Template rendering needs a filesystem, or templates registered up front on this runtime.

**Fix:** app.set('views', ...) on Node, or configure({ views: { 'index.ejs': fn } }) on the edge.

## EXPHONO_E003 — Filesystem is not reachable

express.static / res.sendFile / res.download need a filesystem or an asset binding.

**Fix:** Bind static assets (env.ASSETS) or serve them from your CDN.

## EXPHONO_E004 — Express 4 path syntax is invalid under compat=5

Express 5 requires named wildcards ('*splat') and brace optionals ('{/:id}').

**Fix:** Pin compat with `import express from 'exphono/v4'`, or migrate the path syntax.

## EXPHONO_E005 — Cannot tell whether this middleware is Express- or Hono-shaped

The function arity is ambiguous (rest args or zero declared parameters).

**Fix:** Wrap it explicitly: app.use(honoMiddleware(fn)).

## EXPHONO_E006 — ETag hash differs from Express

This runtime has no synchronous MD5, so a different (still stable) hash is used.

**Fix:** Provide your own with app.set('etag', fn) if byte-identical ETags matter.

## EXPHONO_E007 — Replacing c.res in a Hono middleware has no effect

Express middleware returns from next() synchronously, so post-next response swapping cannot be applied.

**Fix:** Rewrite the route as a Hono handler, or mutate headers before calling next().

## EXPHONO_E008 — This API only exists in Express 4

It was removed in Express 5 and is only available under compat=4.

**Fix:** Use `import express from 'exphono/v4'`, or migrate off the deprecated API.

## EXPHONO_E009 — Depending on an Express internal

ExpHono keeps the name, but its internal structure differs, so behaviour isn't guaranteed.

**Fix:** Prefer the public API.

## EXPHONO_E010 — Deep import of express internals cannot be resolved

ExpHono does not expose 'express/lib/*'.

**Fix:** Use the public API surface.

## EXPHONO_E011 — A namespace import cannot be called

`import * as express` produces a module namespace object, which is not callable.

**Fix:** Use `import express from 'exphono'`.

## EXPHONO_E012 — This API is not implemented yet

The surface exists so your code loads, but calling it does nothing useful yet.

**Fix:** Track progress in the compatibility table.
