/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Static file server for the Playwright suite (playwright.config.js -> webServer).
 *
 * Why this instead of ./serve.sh
 * -----------------------------
 * serve.sh backgrounds `php -S` and returns immediately, so there is no
 * foreground process for Playwright to own and kill; it also rewrites
 * version.json and php-versions.json as a side effect, and it needs a `php`
 * binary, which is not a given on a checkout that only has Node installed.
 * Playwright needs a server it started, on a port it picked, that dies with it.
 *
 * Why the examples need a route at all
 * ------------------------------------
 * Off github.io both pages load an example through examples/_get_file.php,
 * whose job is to return examples/<name>.php as text/plain instead of letting
 * the server execute it (see playground/assets/js/playground.js). A dumb static
 * server would happily return the source of _get_file.php itself, so every
 * example would inject PHP source into the editor. This server reproduces that
 * endpoint's contract -- basename(), an allow-list built from the directory, and
 * a 404 for anything else -- so the tests exercise the same request the browser
 * makes in development.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const HOST = process.env.PLAYGROUND_HOST || '127.0.0.1'
const PORT = Number(process.env.PLAYGROUND_PORT || 8000)

/** The examples endpoint both pages call when they are not on github.io. */
const EXAMPLES_ENDPOINT = '/examples/_get_file.php'

/**
 * `application/wasm` matters: Emscripten's streaming instantiation refuses
 * anything else, and the browser refuses it a second time when it sniffs the
 * response for WebAssembly.
 */
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  // Deliberately not text/x-php: nothing here executes PHP. The playground reads
  // examples as source, so serving them as source is the honest answer, and it
  // is what github.io ends up doing as well.
  '.php': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    // A test run must never be served a stale asset from a previous one.
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
  })
  response.end(body)
}

/** Mirrors the allow-list in examples/_get_file.php. */
function acceptedExamples() {
  const dir = join(ROOT, 'examples')
  return readdirSync(dir)
    .filter(entry => entry !== '_get_file.php' && entry !== 'examples.json')
    .filter(entry => entry.endsWith('.php'))
    .map(entry => entry.replace(/\.php$/, ''))
}

function serveGetFile(url, response) {
  const requested = url.searchParams.get('file')
  if (requested === null) return send(response, 400, 'Bad Request.')

  // basename() in PHP, i.e. the last path segment only: a query like
  // file=../secrets is not an example and must not resolve outside examples/.
  const example = requested.split(/[\\/]/).pop()
  if (!acceptedExamples().includes(example)) return send(response, 404, 'File not found.')

  return sendFile(join(ROOT, 'examples', `${example}.php`), response)
}

function sendFile(path, response) {
  if (!existsSync(path) || !statSync(path).isFile()) return send(response, 404, 'File not found.')
  const body = createReadStream(path)
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(path)] || 'application/octet-stream',
    // no-store, see send()
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
  })
  body.pipe(response)
  body.on('error', () => send(response, 500, 'Internal Server Error.'))
}

/**
 * Extra path prefixes the playground is also served under.
 *
 * The playground derives the WASM module URLs from the directory its page was
 * loaded from, so a subdirectory deployment is the case that has to work for a
 * fork or a rename. Serving the same tree under a prefix makes that testable
 * instead of theoretical.
 */
const MOUNT_PREFIXES = ['/my-fork/my-repo/playground']

const server = createServer((request, response) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${HOST}:${PORT}`).pathname)
  } catch {
    return send(response, 400, 'Bad Request.')
  }

  // Kept for the trailing-slash redirect below, which has to judge the URL the
  // client actually asked for rather than the path after the mount is stripped.
  const requested = pathname

  const mount = MOUNT_PREFIXES.find(
    prefix => pathname === prefix || pathname === `${prefix}/` || pathname.startsWith(`${prefix}/`)
  )
  if (mount) {
    pathname = pathname.slice(mount.length) || '/'
  }

  if (pathname === EXAMPLES_ENDPOINT) return serveGetFile(new URL(request.url, 'http://localhost'), response)

  // Resolve inside ROOT and reject anything that escapes it.
  const target = resolve(join(ROOT, pathname))
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return send(response, 403, 'Forbidden.')

  // Real static hosts redirect a slash-less directory to the slashed form,
  // because "/playground" would otherwise make every relative URL in the page
  // resolve against its parent. Emulate that, or a test for it would be testing
  // this server rather than the playground.
  if (existsSync(target) && statSync(target).isDirectory() && !requested.endsWith('/')) {
    const query = new URL(request.url, `http://${HOST}:${PORT}`).search
    response.writeHead(301, { Location: `${requested}/${query}` })
    return response.end()
  }

  // "/" and "/multi" are directory requests, not file requests.
  const path = existsSync(target) && statSync(target).isDirectory() ? join(target, 'index.html') : target

  return sendFile(path, response)
})

server.listen(PORT, HOST, () => {
  console.log(`Playground test server: http://${HOST}:${PORT}/ (root: ${ROOT})`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
