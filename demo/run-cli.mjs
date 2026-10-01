/**
 * Run a PHP script with the PHP-WASM module, on the command line.
 *
 * Adapted from the demo in derickr/php-wasm-builder:
 * https://github.com/derickr/php-wasm-builder/tree/main/demo
 *
 * The original imports the module from a hardcoded build path and discards the
 * return value. This version takes the module path as an argument, so it can
 * run against either the fast relink output or a module built by the Dockerfile,
 * and it reports the exit status that phpw_run() returns.
 *
 * Usage:
 *   node run-cli.mjs <script.php> [module.mjs]
 *
 * The module defaults to the output of build-tools/scripts/test-bridge.sh and
 * can be overridden with PHP_WASM_MODULE.
 *
 * The module is built for ENVIRONMENT=web,worker,node, so any node will load
 * it. Inside the devcontainer, use the one emsdk installed:
 *   source /local/src/emsdk/emsdk_env.sh
 */
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_MODULE = '/tmp/php-wasm-bridge-test/php-wasm-bridge.mjs';

const [scriptArg, moduleArg] = process.argv.slice(2);

if (!scriptArg) {
  console.error('usage: node run-cli.mjs <script.php> [module.mjs]');
  process.exit(2);
}

const modulePath = resolve(moduleArg ?? process.env.PHP_WASM_MODULE ?? DEFAULT_MODULE);
const scriptPath = resolve(scriptArg);

if (!existsSync(modulePath)) {
  console.error(`error: module not found: ${modulePath}`);
  console.error('       Build one with ./build-tools/scripts/test-bridge.sh, or set');
  console.error('       PHP_WASM_MODULE to the path of an existing module.');
  process.exit(2);
}

if (!existsSync(scriptPath)) {
  console.error(`error: script not found: ${scriptPath}`);
  process.exit(2);
}

const createPhpModule = (await import(pathToFileURL(modulePath))).default;

/*
 * The embed SAPI writes to stdout, which Emscripten delivers to these callbacks.
 *
 * Each chunk is written as it arrives rather than collected and joined at the
 * end, so a script that produces output incrementally streams instead of
 * appearing all at once when the request ends. Nothing is inserted between
 * chunks: the bridge ends a request with php_output_flush_all(), so the output
 * of a request arrives as a whole rather than one line-buffered fragment at a
 * time. The playground still joins chunks with a newline, which is what
 * playground/assets/js/playground.js is up for.
 */
const { ccall } = await createPhpModule({
  print: (data) => {
    if (data) process.stdout.write(data);
  },
  printErr: (data) => {
    if (data) process.stderr.write(data);
  },
});

const code = fs.readFileSync(scriptPath, 'utf8');

/*
 * The leading `?>` is what makes the file run as a script instead of being
 * echoed as inline HTML, since phpw_run() evaluates it as inline code. The
 * playground prepends the same marker.
 *
 * phpw_run() returns 0 on success, or one of the PHPW_* codes on failure, with
 * the reason available from phpw_last_error().
 */
const status = ccall('phpw_run', 'number', ['string'], [`?>${code}`]);

if (status !== 0) {
  const reason = ccall('phpw_last_error', 'string', [], []);

  if (reason) {
    process.stderr.write(`phpw_run failed: ${reason}\n`);
  }
}

process.exitCode = status;
