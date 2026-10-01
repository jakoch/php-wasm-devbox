# Demo

Run a PHP script with the PHP-WASM module from the command line. Adapted from
the demo in [derickr/php-wasm-builder](https://github.com/derickr/php-wasm-builder/tree/main/demo).

## Requirements

A built module. The fastest way to get one is the bridge test runner, which
relinks the bridge against the `libphp.a` already present in the build-stage
image and leaves the module in `/tmp/php-wasm-bridge-test`:

```bash
./build-tools/scripts/test-bridge.sh
```

The module is built for `ENVIRONMENT=web,worker,node`, so any `node` loads it.
Node 24 is what the image installs for this; the bridge suite is run against it
by `build-tools/scripts/test-bridge.sh`. Outside the devcontainer, any recent
`node` works — verified on v20.18.0 and v24.21.0.

## Usage

```bash
node demo/run-cli.mjs demo/phpinfo.php
```

Pass a different module as the second argument, or set `PHP_WASM_MODULE`:

```bash
node demo/run-cli.mjs demo/phpinfo.php /php-wasm/php-8.4.10-web.mjs
```

The exit status is PHP's: `0` on success, non-zero on a parse error or an
uncaught exception.

## Files

- `run-cli.mjs` — loads the module and runs the script through `phpw_run()`
- `phpinfo.php` — `phpinfo()`, i.e. the usual smoke test for a PHP build

## Request context

`phpw_run()` runs a script with no request context, so `$_GET`, `$_POST` and the
CGI entries of `$_SERVER` are empty. To populate them, call `phpw_request_init()`
before `phpw_run()` — see `test/php-wasm-bridge.test.mjs` for worked examples:

```js
ccall(
  'phpw_request_init',
  'number',
  ['string', 'string', 'string', 'string', 'string', 'string'],
  ['POST', '', 'application/x-www-form-urlencoded', 'user=jane', '/index.php', '/index.php']
);
```
