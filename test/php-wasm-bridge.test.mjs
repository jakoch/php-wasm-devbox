/**
 * Regression tests for the PHP-WASM bridge (src/php-wasm-bridge.c).
 *
 * Run with:  node test/php-wasm-bridge.test.mjs <path-to>/php-<version>-web.mjs
 *
 * The suite targets the defects fixed in the bridge rewrite:
 *
 *   1. phpw_exec() returned a pointer into a request that php_embed_shutdown()
 *      had already freed, so the result was only valid until the next call.
 *   2. A parse error left the return zval uninitialised, and the caller got
 *      whatever happened to be on the stack.
 *   3. php_embed_init()/php_embed_shutdown() ran per execution, which wiped
 *      request context and leaked a live request per call.
 *
 * Section 2 and 3 are the interesting ones: they are what a caller hits when
 * it holds on to a result across another execution, which the documented
 * `ccall` usage pattern does not do but real applications do.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modulePath = process.argv[2];

if (!modulePath) {
  console.error('usage: node php-wasm-bridge.test.mjs <path to php-*-web.mjs>');
  process.exit(2);
}

const stderr = [];
// The embed SAPI writes to stdout, which arrives here. This is exactly how the
// playground collects PHP output, so the suite asserts on the same path rather
// than on a bridge-specific buffer.
let stdout = '';
const createPhpModule = (await import(pathToFileURL(resolve(modulePath)))).default;

const mod = await createPhpModule({
  print: (data) => {
    stdout += data;
  },
  printErr: (...args) => stderr.push(args.join(' ')),
  onAbort: (reason) => {
    throw new Error(`WASM aborted: ${reason}`);
  },
});

/**
 * Run code and return everything it wrote to stdout.
 *
 * Note: Emscripten's Node TTY is line buffered, so a write that does not end in
 * a newline is not delivered until a later one arrives. In a browser `print` is
 * called synchronously and this does not apply, but the test runs under Node, so
 * the cases below are newline terminated.
 */
function execStdout(code) {
  stdout = '';
  exec(code);
  return stdout;
}

/** Emscripten's Node TTY drops trailing newlines; compare on content. */
function trimmed(value) {
  return value.replace(/\n+$/, '');
}

const { ccall, FS } = mod;

let checks = 0;
let failures = 0;
const failed = [];

function check(name, actual, expected) {
  checks++;
  if (actual === expected) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  failed.push(name);
  console.log(`  FAIL ${name}`);
  console.log(`         expected: ${JSON.stringify(expected)}`);
  console.log(`         actual:   ${JSON.stringify(actual)}`);
}

/**
 * phpw_exec() returns NULL on failure, which ccall surfaces as "".
 * This is the calling convention the playground and the project README use.
 */
function exec(code) {
  return ccall('phpw_exec', 'string', ['string'], [code]);
}

function run(code) {
  return ccall('phpw_run', 'number', ['string'], [code]);
}

function lastError() {
  const value = ccall('phpw_last_error', 'string', [], []);
  return value === 0 ? null : value;
}

function request(method, query, contentType, body, scriptName = '/index.php', uri = '/index.php') {
  ccall(
    'phpw_request_init',
    'number',
    ['string', 'string', 'string', 'string', 'string', 'string'],
    [method, query, contentType, body, scriptName, uri]
  );
}

console.log('# baseline');
check('phpw_init() succeeds', ccall('phpw_init', 'number', [], []), 0);
check('phpw_init() is idempotent', ccall('phpw_init', 'number', [], []), 0);
check('a PHP version is reported', /^8\.\d+\.\d+/.test(ccall('phpw_php_version', 'string', [], [])), true);

console.log('\n# 1. expressions and return types');
// zend_eval_string() yields whatever type the expression produced. A bridge
// that forgets convert_to_string() returns "" for everything non-string.
check('string result', exec("'abc'"), 'abc');
check('int result', exec('1+1'), '2');
check('float result', exec('3.5'), '3.5');
check('bool true', exec('true'), '1');
check('null', exec('null'), '');
check('function call', exec("strtoupper('abc')"), 'ABC');
check('multiline expression', exec("implode('-', ['a','b','c'])"), 'a-b-c');

console.log('\n# 2. the use-after-free regression');
// The bug: phpw_exec() returned Z_STRVAL() of a request-scoped zval and then
// shut the request down, so the pointer dangled. Holding a large result across
// another execution is what made it observable -- the freed block gets reused.
const held = exec("str_repeat('A', 262144)");
check('large result has the right length', held.length, 262144);
check('large result is not corrupted', /^A+$/.test(held), true);

const other = exec("str_repeat('B', 262144)");
check('the other result is intact too', /^B+$/.test(other), true);
check('the first result survived the second call', /^A+$/.test(held), true);
check('the first result kept its length', held.length, 262144);
check('the first result is still equal to itself', held === exec("str_repeat('A', 262144)"), true);

// Content, not just length: recycled memory shows up as wrong bytes.
const MARKER = '-END-MARKER-';
const marked = exec("str_repeat('x', 100000) . '" + MARKER + "'");
check('a tail marker survives', marked.endsWith(MARKER), true);
check('a tail marker keeps the exact length', marked.length, 100000 + MARKER.length);

console.log('\n# 3. repeated execution stays stable');
let stable = true;
let firstBadIteration = -1;
for (let i = 0; i < 500; i++) {
  const value = exec("str_repeat('y', 4096) . " + i);
  if (value.length !== 4096 + String(i).length || !value.endsWith(String(i))) {
    stable = false;
    firstBadIteration = i;
    break;
  }
}
check('500 sequential executions stay correct', stable, true);
if (!stable) {
  console.log(`         first bad iteration: ${firstBadIteration}`);
}

console.log('\n# 4. errors are reported instead of returning garbage');
// A parse error used to leave the return zval uninitialised.
check('a parse error returns NULL', ccall('phpw_exec', 'number', ['string'], ['function((']), 0);
check('a parse error is described', lastError(), 'parse error in expression');
check('a thrown exception returns NULL', ccall('phpw_exec', 'number', ['string'], ['throw new Exception("boom");']), 0);
check('the exception message is surfaced', lastError(), 'boom');
check('a division by zero is reported', ccall('phpw_exec', 'number', ['string'], ['intdiv(1, 0);']), 0);
check('the Error message is surfaced', lastError(), 'Division by zero');
check('an undefined method is reported', ccall('phpw_exec', 'number', ['string'], ['(new DateTime())->nope();']), 0);
// The module must remain usable after every one of those failures.
check('it still works after failures', exec('2*21'), '42');

console.log('\n# 5. each execution gets a fresh request');
check('a superglobal is readable within one request', exec("array_key_exists('probe', $GLOBALS) ? 'yes' : 'no'"), 'no');
// Set a global in one execution, then look for it in the next. If the request
// were reused instead of cycled, the value would survive.
check('setting a global succeeds', exec("$GLOBALS['leakProbe'] = 1"), '1');
check('it does not survive into the next request', exec("array_key_exists('leakProbe', $GLOBALS) ? 'leaked' : 'clean'"), 'clean');
check('output is empty for a silent expression', (stdout = '', exec("1+1"), stdout), '');

console.log('\n# 6. output reaches stdout');
// Output must NOT be buffered inside the bridge: the playground displays
// whatever arrives via the `print:` callback, so swallowing it would blank the
// output panel.
check('phpw_run() succeeds', run('echo "hello\\n";'), 0);
check('phpw_run() output reaches stdout', trimmed(stdout), 'hello');
check('output is per-execution, not accumulated', (stdout = '', run('echo "second\\n";'), trimmed(stdout)), 'second');
check('phpw_exec() output reaches stdout', trimmed(execStdout('print "via exec\\n"')), 'via exec');
// Where PHP sends fatal errors is a SAPI/TTY detail that differs between Node
// and the browser, so only the stdout content of a normal script is asserted.
check('a silent expression writes nothing', execStdout('1 + 1'), '');

console.log('\n# 7. phpw_run() exit codes');
check('a clean script returns 0', run('$x = 1;'), 0);
check('an uncaught exception returns 2', run('throw new RuntimeException("x");'), 2);
check('a parse error returns 1', run('function(('), 1);
check('a fatal error returns 2', run('nonexistent_function_xyz();'), 2);
check('it still succeeds afterwards', run('1;'), 0);

console.log('\n# 8. request context: query string and $_GET');
request('GET', 'foo=bar&n=42', '', '');
check('$_GET value', exec('$_GET["foo"] ?? "MISSING"'), 'bar');
check('$_GET numeric value', exec('$_GET["n"] ?? "MISSING"'), '42');
check('$_GET is not sticky', (request('GET', 'a=1', '', ''), exec('isset($_GET["foo"]) ? "leaked" : "fresh"')), 'fresh');

console.log('\n# 9. request context: $_SERVER');
request('GET', 'foo=bar', '', '', '/index.php', '/index.php?foo=bar');
check('$_SERVER[REQUEST_METHOD]', exec('$_SERVER["REQUEST_METHOD"] ?? "MISSING"'), 'GET');
check('$_SERVER[QUERY_STRING]', exec('$_SERVER["QUERY_STRING"] ?? "MISSING"'), 'foo=bar');
check('$_SERVER[SCRIPT_NAME]', exec('$_SERVER["SCRIPT_NAME"] ?? "MISSING"'), '/index.php');
check('$_SERVER[REQUEST_URI]', exec('$_SERVER["REQUEST_URI"] ?? "MISSING"'), '/index.php?foo=bar');

console.log('\n# 10. request context: POST body');
request('POST', '', 'application/x-www-form-urlencoded', 'user=jane&age=30');
check('$_POST value', exec('$_POST["user"] ?? "MISSING"'), 'jane');
check('$_POST numeric value', exec('$_POST["age"] ?? "MISSING"'), '30');
check('$_POST entry count', exec('count($_POST)'), '2');
check('$_SERVER[REQUEST_METHOD] is POST', exec('$_SERVER["REQUEST_METHOD"] ?? "MISSING"'), 'POST');
check('$_SERVER[CONTENT_TYPE]', exec('$_SERVER["CONTENT_TYPE"] ?? "MISSING"'), 'application/x-www-form-urlencoded');
check('$_SERVER[CONTENT_LENGTH]', exec('$_SERVER["CONTENT_LENGTH"] ?? "MISSING"'), '16');
check('php://input is the raw body', exec('file_get_contents("php://input")'), 'user=jane&age=30');
check('$_POST is cleared on the next request', (request('GET', '', '', ''), exec('count($_POST)')), '0');

console.log('\n# 11. a large POST body is delivered whole');
const largeBody = 'k=' + 'v'.repeat(100000);
request('POST', '', 'application/x-www-form-urlencoded', largeBody);
check('large body length', exec('strlen($_POST["k"] ?? "")'), '100000');
check('large body content', exec('($_POST["k"] ?? "") === str_repeat("v", 100000) ? "same" : "differs"'), 'same');

console.log('\n# 12. file execution');
FS.writeFile('/tmp/phpw-test-ok.php', '<?php echo "from file\\n";');
check('phpw() on a valid file returns 0', (stdout = '', ccall('phpw', 'number', ['string'], ['/tmp/phpw-test-ok.php'])), 0);
check('file output reaches stdout', trimmed((stdout = '', ccall('phpw', 'number', ['string'], ['/tmp/phpw-test-ok.php']), stdout)), 'from file');
check('phpw() on a missing file fails', ccall('phpw', 'number', ['string'], ['/tmp/phpw-absent-file.php']) !== 0, true);
check('it still works after a missing file', exec('1+1'), '2');

console.log('\n# 13. the virtual filesystem persists across requests');
check('write from PHP', exec('file_put_contents("/tmp/persist.txt", "kept") === 4 ? "ok" : "short write"'), 'ok');
check('read back from PHP', exec('file_get_contents("/tmp/persist.txt")'), 'kept');

console.log('\n# 14. compiled-in extensions still work');
check('mbstring', exec('mb_strtoupper("äöü")'), 'ÄÖÜ');
check('json', exec('json_encode(["a" => 1])'), '{"a":1}');
check('dom', exec('class_exists("DOMDocument") ? "yes" : "no"'), 'yes');
check('pdo', exec('class_exists("PDO") ? "yes" : "no"'), 'yes');
check('simplexml', exec('function_exists("simplexml_load_string") ? "yes" : "no"'), 'yes');

console.log('\n# 15. returned memory is owned by the caller');
// phpw_exec() hands back malloc'd memory; phpw_free() must release it without
// disturbing the module.
{
  const ptr = ccall('phpw_exec', 'number', ['string'], ['str_repeat("z", 1024)']);
  check('a raw pointer is returned', ptr > 0, true);
  // Read the buffer directly out of the module's heap: this is the memory the
  // caller now owns, and it must be readable and NUL-terminated.
  const head = mod.HEAPU8.subarray(ptr, ptr + 1024);
  check('the returned buffer is readable', head.every((byte) => byte === 0x7a), true);
  check('the returned buffer is NUL terminated', mod.HEAPU8[ptr + 1024], 0);
  ccall('phpw_free', null, ['number'], [ptr]);
  check('the module still works after phpw_free()', exec('1+1'), '2');
}

console.log('\n# 16. teardown and re-init');
ccall('phpw_destroy', null, [], []);
// phpw_exec() re-initialises lazily, so it must keep working rather than crash.
check('phpw_exec() after destroy re-initialises', exec('1+1'), '2');
check('re-init succeeds', ccall('phpw_init', 'number', [], []), 0);
check('execution works after re-init', exec('1+1'), '2');
check('superglobals work after re-init', (request('GET', 'z=9', '', ''), exec('$_GET["z"] ?? "MISSING"')), '9');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`);
if (failed.length) {
  console.log('failed: ' + failed.join(', '));
}
if (stderr.length) {
  console.log('\n--- stderr (last 10 lines) ---\n' + stderr.slice(-10).join('\n'));
}

process.exit(failures === 0 ? 0 : 1);
