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
/* The same print() calls kept individually: Emscripten strips the newline, so a
 * blank line arrives as an empty call and only the boundaries show it. */
const stdoutChunks = [];
/*
 * Emscripten captures the printErr callback passed to createPhpModule() and
 * never consults Module.printErr again, so reassigning it after construction
 * captures nothing. Routing through a mutable sink is the only way to borrow the
 * stream for one dump. Keep `sink` separate from `stderr`: sharing one variable
 * makes a broken capture look like a working one.
 */
let sink = null;
const createPhpModule = (await import(pathToFileURL(resolve(modulePath)))).default;

const mod = await createPhpModule({
  print: (data) => {
    stdoutChunks.push(data);
    stdout += data;
  },
  printErr: (...args) => {
    const text = args.join(' ');
    if (sink) {
      sink(text);
      return;
    }
    stderr.push(text);
  },
  onAbort: (reason) => {
    throw new Error(`WASM aborted: ${reason}`);
  },
});

/**
 * Run code and return everything it wrote to stdout.
 *
 * An unterminated write used to be held in Emscripten's TTY buffer until a later
 * newline arrived -- not a Node-only quirk, it blanked the playground's output
 * panel in Chromium too. Section 18 keeps that fixed.
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

/** Buffer size sapi_read_post_block() passes to the read_post hook (main/SAPI.h). */
const SAPI_POST_BLOCK_SIZE = 0x4000;

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
  // ccall() decodes a NULL char* as '', never as the number 0, so an empty
  // string is what "no error" looks like from here.
  return value === '' ? null : value;
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

console.log('\n# 4b. results that cannot be returned as a string');
// A non-castable object used to surface as the generic "execution aborted".
check('a bare object returns NULL', ccall('phpw_exec', 'number', ['string'], ['new stdClass();']), 0);
check('the reason names the class', lastError(), 'Object of class stdClass could not be converted to string');
check('an object without __toString, via a closure', ccall('phpw_exec', 'number', ['string'], ['(function () { return new ArrayObject([]); })();']), 0);
check('the reason names that class too', lastError(), 'Object of class ArrayObject could not be converted to string');
// An object that can be cast is still returned normally.
check('an object with __toString converts', exec('(function () { $o = new class { public function __toString(): string { return "custom"; } }; return $o; })()'), 'custom');
// Creating objects is fine; only returning one is not. phpw_run() was never affected.
check('an object created but not returned is fine', exec('(function () { $o = new stdClass(); return 42; })()'), '42');
check('the module still works', exec('2*21'), '42');
check('phpw_run() with an object returns 0', run('$o = new stdClass();'), 0);
check('and reports no error', lastError(), null);

console.log('\n# 4c. phpw_exec() evaluates a single expression');
// zend_eval_string() yields the first statement's value: 1, not 2.
check('only the first statement is the result', exec('$a = 1; $a + 1;'), '1');
check('an IIFE returns its last value', exec('(function () { $a = 1; return $a + 1; })()'), '2');
check('a trailing semicolon is fine on a single statement', exec('1 + 1;'), '2');

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

// A body of exactly one SAPI_POST_BLOCK_SIZE is where an off-by-one in the
// offset arithmetic truncates it instead of ending the read loop.
console.log('\n# 11b. POST bodies around the read_post block size');
for (const total of [SAPI_POST_BLOCK_SIZE - 1, SAPI_POST_BLOCK_SIZE, SAPI_POST_BLOCK_SIZE + 1]) {
  const expected = 'v'.repeat(total - 2);
  request('POST', '', 'application/x-www-form-urlencoded', `k=${expected}`);
  check(`body of ${total} bytes: entry count`, exec('count($_POST)'), '1');
  check(`body of ${total} bytes: length`, exec('strlen($_POST["k"] ?? "MISSING")'), String(expected.length));
  check(
    `body of ${total} bytes: content`,
    exec(`($_POST["k"] ?? "") === str_repeat("v", ${expected.length}) ? "same" : "differs"`),
    'same'
  );
}

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

// The checks above only prove an extension compiled in. These call into sqlite3,
// which is what catches a libsqlite3.a missing from the link line: the module
// still links, and class_exists('PDO') still passes.
check('sqlite3 is linked', /^\d+\.\d+/.test(exec('(new SQLite3(":memory:"))->version()["versionString"];')), true);
check('pdo_sqlite driver', exec('in_array("sqlite", PDO::getAvailableDrivers()) ? "yes" : "no"'), 'yes');

// Wrapped in a closure: phpw_exec() evaluates one expression.
check('a query runs', exec(
  '(function() {'
  + '  $p = new PDO("sqlite::memory:");'
  + '  $p->exec("CREATE TABLE t (a)");'
  + '  $p->exec("INSERT INTO t VALUES (42)");'
  + '  return (string) $p->query("SELECT a FROM t")->fetchColumn();'
  + '})()'
), '42');

// phpinfo() reports the sqlite version, so it aborts the module when the link
// is incomplete. Run via phpw_run() and captured, to keep 50KB out of the output.
run('ob_start(); phpinfo(); file_put_contents("/tmp/phpw-phpinfo.html", ob_get_clean());');
{
  const info = Buffer.from(FS.readFile('/tmp/phpw-phpinfo.html')).toString();
  check('phpinfo() reports sqlite3', info.includes('sqlite3'), true);
  check('phpinfo() reports PDO', info.includes('PDO'), true);
}

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

console.log('\n# 16. opcode dumping via VLD (optional extension)');
// Everything here is skipped when the module was built without VLD, so the suite
// still passes on such a build. What it cannot skip is the *shape*: if VLD is
// present, the dump must come back and must not execute the snippet.
{
  // Configure VLD without letting the bridge decide for us, so a missing
  // extension is distinguishable from a refusal.
  const hasVld = exec("extension_loaded('vld') ? 'yes' : 'no'") === 'yes';

  if (!hasVld) {
    console.log('  skip built without VLD (ENABLE_VLD=0)');
    console.log('\n# 17. teardown and re-init');
    ccall('phpw_destroy', null, [], []);
    // phpw_exec() re-initialises lazily, so it must keep working rather than crash.
    check('phpw_exec() after destroy re-initialises', exec('1+1'), '2');
    check('re-init succeeds', ccall('phpw_init', 'number', [], []), 0);
    check('execution works after re-init', exec('1+1'), '2');
    check(
      'superglobals work after re-init',
      (request('GET', 'z=9', '', ''), exec('$_GET["z"] ?? "MISSING"')),
      '9'
    );
  } else {
    const VLD_DIR = '/vld';
    const SNIPPET = `${VLD_DIR}/code.php`;

    /**
     * Compile a snippet with dumping on and the executor disabled, and collect
     * everything VLD writes to stderr. This mirrors PHP.getOpcodes() in
     * assets/js/playground.js, including borrowing the printErr stream, because
     * that is the only path by which the dump can reach the playground.
     *
     * vld.dump_paths is left off: its branch analysis is written to stdout, not
     * stderr, so turning it on would leak fragments into the script output the
     * "nothing leaked to stdout" check asserts on.
     */
    function dumpOpcodes(code, verbosity = 1) {
      const status = ccall(
        'phpw_vld_config',
        'number',
        ['number', 'number', 'number', 'number'],
        [1, 0, verbosity, 0]
      );
      if (status !== 0) {
        return { error: lastError() };
      }

      const lines = [];
      sink = (data) => lines.push(`${data}\n`);
      let rc = 0;
      try {
        try {
          FS.mkdir(VLD_DIR);
        } catch {
          /* EEXIST */
        }
        FS.writeFile(SNIPPET, code);
        rc = ccall('phpw', null, ['string'], [SNIPPET]);
      } finally {
        sink = null;
        ccall(
          'phpw_vld_config',
          'number',
          ['number', 'number', 'number', 'number'],
          [0, 1, 1, 0]
        );
        try {
          FS.unlink(SNIPPET);
        } catch {
          /* already gone */
        }
      }
      return { text: lines.join(''), error: rc === 0 ? null : lastError() };
    }

    check('phpw_vld_config() accepts verbosity 0', ccall('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 0, 0]), 0);
    check('phpw_vld_config() accepts verbosity 3', ccall('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 3, 0]), 0);
    check('phpw_vld_config() rejects verbosity 4', ccall('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 4, 0]), 1);
    ccall('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 1, 0]);

    // The snippet calls a function so the dump contains a call opcode as well as
    // the ECHO: '<?php echo 1;' compiles to ECHO and RETURN only, and would never
    // emit INIT_FCALL for the check below to find.
    const dump = dumpOpcodes('<?php function twice($n) { return $n + $n; } echo twice(1);');
    check('a dump is produced', dump.error, null);
    check('the dump names the script', /filename:\s*\/vld\/code\.php/.test(dump.text || ''), true);
    check('the dump contains opcodes', /INIT_FCALL/.test(dump.text || ''), true);
    check('the dump contains ECHO', /\bECHO\b/.test(dump.text || ''), true);

    // The whole point of vld.execute=0: the snippet must not run. If it did, the
    // marker would land on stdout and the dump would not be a pure disassembly.
    stdout = '';
    const sideEffect = dumpOpcodes('<?php file_put_contents("/tmp/phpw-vld-ran", "yes");');
    check('a snippet with side effects compiles cleanly', sideEffect.error, null);
    check('the snippet did not execute', FS.analyzePath('/tmp/phpw-vld-ran').exists, false);
    check('nothing leaked to stdout', stdout, '');

    // vld.active=0 must leave ordinary runs alone, or the Errors panel fills up.
    // phpw_run(), not phpw_exec(): the latter drops echo() output in this bridge,
    // which would make this pass or fail for reasons that have nothing to do
    // with VLD. The newline keeps Emscripten's line-buffered Node TTY happy.
    stdout = '';
    ccall('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 1, 0]);
    run("echo 'quiet', PHP_EOL;");
    check('a normal run is not dumped', stdout.trim(), 'quiet');

    // Repeated dumps must not accumulate state in the module.
    let repeatsOk = true;
    for (let i = 0; i < 50; i++) {
      if (dumpOpcodes(`<?php $i + $i;`).error !== null) repeatsOk = false;
    }
    check('50 consecutive dumps all succeed', repeatsOk, true);
    check('the module still executes after 50 dumps', exec('1+1'), '2');

    console.log('\n# 17. teardown and re-init');
    ccall('phpw_destroy', null, [], []);
    // phpw_exec() re-initialises lazily, so it must keep working rather than crash.
    check('phpw_exec() after destroy re-initialises', exec('1+1'), '2');
    check('re-init succeeds', ccall('phpw_init', 'number', [], []), 0);
    check('execution works after re-init', exec('1+1'), '2');
    check(
      'superglobals work after re-init',
      (request('GET', 'z=9', '', ''), exec('$_GET["z"] ?? "MISSING"')),
      '9'
    );
  }
}

console.log('\n# 18. output is flushed even when it has no trailing newline')
// Regression: an unterminated write used to be held in Emscripten's TTY buffer
// until some later newline arrived, so it printed nothing and turned up in the
// *next* run. phpw_flush() now drains that buffer with fsync(1).
{
  // The print handler above concatenates raw, which would flatten blank lines;
  // the playground re-joins the calls with "\n", so these do the same.
  function collected(code) {
    stdoutChunks.length = 0
    run(code)
    return stdoutChunks.join('\n')
  }

  check('an unterminated echo reaches stdout', ((stdout = ''), run('echo "abc";'), stdout), 'abc')

  // The bleed was the user-visible half: the next run must show only its own output.
  check('it does not bleed into the next run', ((stdout = ''), run('echo "second";'), stdout), 'second')
  check('and again', ((stdout = ''), run('echo "third";'), stdout), 'third')

  check('an unterminated print() reaches stdout', execStdout('print "no-newline"'), 'no-newline')
  check('printf() without a newline reaches stdout', execStdout('printf("%s-%s", "a", "b")'), 'a-b')

  // phpw() is the path the playground uses; all three entry points had the bug.
  FS.writeFile('/tmp/phpw-test-no-newline.php', '<?php echo "from file, unterminated";')
  check(
    'phpw() delivers an unterminated file script',
    ((stdout = ''), ccall('phpw', 'number', ['string'], ['/tmp/phpw-test-no-newline.php']), stdout),
    'from file, unterminated'
  )

  // A flush() inside the script must not add a byte, and neither must the bridge.
  // zend_eval_string() compiles an *expression*, so a bare `echo "x";` is refused.
  check('flush() does not add a newline', ((stdout = ''), run('echo "flush-me"; flush();'), stdout), 'flush-me')
  check(
    'phpw_exec() refuses a bare statement',
    ((stdout = ''), exec('echo "x";'), lastError()),
    'parse error in expression'
  )

  // Blank lines are real output: the WP-01.7 regression, in a second place.
  check('blank lines survive', collected('echo "a\\n\\n\\nb\\n";'), 'a\n\n\nb')
  check('a lone newline survives', collected('echo "\\n";'), '')

  // A diagnostic used to be the only thing that flushed a pending tail, and it
  // used to arrive on stdout. Both are now fixed, so it flushes nothing.
  check(
    'a diagnostic does not disturb stdout',
    ((stdout = ''), run('echo "before"; trigger_error("w", E_USER_WARNING);'), stdout),
    'before'
  )
  check(
    'and does not lose the pending tail',
    ((stdout = ''), run('echo "tail"; trigger_error("w", E_USER_WARNING);'), stdout),
    'tail'
  )

  // Per-execution isolation must survive all of that.
  check('exec still returns its value', exec('1+1'), '2')
  check('and stdout is empty for a silent expression', execStdout('1+1'), '')
}

console.log('\n# 19. diagnostics go to stderr, program output to stdout')
// The embed SAPI has no stderr display path: php_error_cb() only honours
// display_errors=stderr when sapi_module.name is cli/cgi/phpdbg (main/main.c).
// phpw_error_cb() borrows that name for the duration of the callback, so the two
// streams are separable and the playground needs no heuristics.
{
  const both = code => {
    stdout = ''
    stderr.length = 0
    run(code)
    return { out: stdout, err: stderr.join('\n') }
  }

  const clean = both('echo "just output\\n";')
  check('a clean script writes no stderr', clean.err, '')
  check('and its output on stdout', clean.out, 'just output')

  const warning = both('echo "before\\n"; trigger_error("boom", E_USER_WARNING);')
  check('a warning leaves stdout', warning.out, 'before')
  check('and lands on stderr', warning.err, 'Warning: boom in script on line 1')

  const fatal = both('echo "kept\\n"; new NoSuchClass();')
  check('a fatal leaves stdout', fatal.out, 'kept')
  check('lands on stderr', /^Fatal error: Uncaught Error: Class "NoSuchClass" not found/m.test(fatal.err), true)
  // The stack trace carries "thrown in ... on line N", which is where the
  // playground reads the line number from.
  check(
    'with its stack trace',
    fatal.err.includes('Stack trace:') && /thrown in script on line \d+/.test(fatal.err),
    true
  )

  // Through phpw(), which is the path the playground uses. phpw_run() reports a
  // compile error only through phpw_last_error(), with no text on either stream.
  stdout = ''
  stderr.length = 0
  FS.writeFile('/tmp/phpw-test-parse.php', '<?php function((')
  check('a parse error returns non-zero', ccall('phpw', 'number', ['string'], ['/tmp/phpw-test-parse.php']) !== 0, true)
  check('a parse error reaches stderr', /^Parse error:/m.test(stderr.join('\n')), true)
  check('and writes nothing to stdout', stdout, '')

  // log_errors is 0 in this build, so a diagnostic must not be duplicated.
  check('no duplicate on stderr', both('trigger_error("once", E_USER_WARNING);').err.split('Warning:').length - 1, 1)

  // The name borrow escapes a fatal error, which longjmps out of the callback,
  // so phpw_request_begin()/end() are what put it back.
  check('the SAPI name is restored', exec('PHP_SAPI'), 'embed')
  check('after a fatal error', (both('new NoSuchClass();'), exec('PHP_SAPI')), 'embed')
  check('and after phpw_destroy()', (ccall('phpw_destroy', null, [], []), exec('PHP_SAPI')), 'embed')
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`);
if (failed.length) {
  console.log('failed: ' + failed.join(', '));
}
if (stderr.length) {
  console.log('\n--- stderr (last 10 lines) ---\n' + stderr.slice(-10).join('\n'));
}

/* process.exitCode, not process.exit(): the latter truncates pending stdout,
 * which silently swallows the per-check FAIL lines above. */
process.exitCode = failures === 0 ? 0 : 1;
