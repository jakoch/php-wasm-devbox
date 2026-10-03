/**
 * Tests for the playground's pure helpers and for PHP.getOpcodes() against a real
 * WASM module.
 *
 * Run with:
 *   node test/opcodes.test.mjs
 *
 * Expects the page modules to be built already, i.e. this from the repo root:
 *   playground/assets/wasm/php-<version>-web.{mjs,wasm}
 *   playground/assets/js/playground.js
 *
 * The module version is picked from playground/assets/wasm/php-versions.json,
 * preferring the highest, and can be overridden:
 *   PHP_WASM_VERSION=8.5.11 node test/opcodes.test.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmDir = resolve(repoRoot, 'playground/assets/wasm');

/** Highest version listed in php-versions.json, honouring $PHP_WASM_VERSION. */
function pickVersion() {
  if (process.env.PHP_WASM_VERSION) return process.env.PHP_WASM_VERSION;

  const listed = JSON.parse(readFileSync(resolve(wasmDir, 'php-versions.json'), 'utf8'));
  const compare = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] || 0) - (pa[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  };

  return [...listed].sort(compare)[0];
}

const version = pickVersion();
const modulePath = resolve(wasmDir, `php-${version}-web.mjs`);

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

const problems = [];
const assert = (name, ok) => {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  failed.push(name);
  problems.push(name);
};

const { escapeHtml, renderOpcodeDump, renderOpcodeLine, setupResultTabs, parseDiagnostics, describeDiagnostics, renderDiagnostics } =
  await import(pathToFileURL(resolve(repoRoot, 'playground/assets/js/playground.js')).href);

console.log(`# version ${version}`);

console.log('\n# 1. escaping');
check('escapes angle brackets', escapeHtml('<b>'), '&lt;b&gt;');
check('escapes ampersand', escapeHtml('a & b'), 'a &amp; b');
check('escapes quotes', escapeHtml('"x" \'y\''), '&quot;x&quot; &#39;y&#39;');

console.log('\n# 2. opcode rendering');
{
  // A real row, as produced by vld_dump_op() in srm_oparray.c.
  const row = "    1     0  E >   JMPZ                                          !0, ->6";
  const html = renderOpcodeLine(row);
  assert('opcode name is marked', html.includes('<span class="opc-name">JMPZ</span>'));
  assert('entry marker is marked', /<span class="opc-mark">E<\/span>/.test(html));
  assert('branch marker is marked', /<span class="opc-mark">&gt;<\/span>/.test(html));
  assert('operand slot is marked', html.includes('<span class="opc-slot">!0</span>'));
  assert('jump target is marked', html.includes('<span class="opc-jump">-&gt;6</span>'));

  // Markers are matched by column, so a '>' inside an operand must not be marked.
  const cmp = renderOpcodeLine("    2     1        JMPZ                                          1, ->9");
  assert('comparison char is not a marker', !/opc-mark">&gt;/.test(cmp.split('opc-name')[1] || ''));

  // A line that is not a listing row must pass through unsliced.
  const summary = 'branch: #  0; line:     1-    1; sop:     0; eop:     4; out0:  -2';
  assert('branch summary is not sliced', !renderOpcodeLine(summary).includes('opc-mark'));
  assert('branch summary text survives', renderOpcodeLine(summary).includes('out0:  -2'));

  // Nothing may inject markup of its own.
  const hostile = renderOpcodeLine('    1     0  E >   ECHO   <img src=x>');
  assert('no unescaped angle brackets', !hostile.replace(/<\/?span[^>]*>/g, '').includes('<'));
}

console.log('\n# 3. dump rendering');
{
  const dump = [
    'filename:       /vld/code.php',
    'number of ops:  2',
    'line      #* E I O op                               fetch          ext  return  operands',
    '-----------------------------------------------------------------------------------------',
    "    1     0  E >   ECHO                                                         'hi'",
    '          1      > RETURN                                                       1',
    '',
    'branch: #  0; line:     1-    1; sop:     0; eop:     1; out0:  -2',
  ].join('\n');

  const rendered = renderOpcodeDump(dump);
  assert('metadata is classed', rendered.html.includes('<span class="opc-meta">filename:'));
  assert('rule is classed', rendered.html.includes('<span class="opc-rule">'));

  // The ruler must be isolated so CSS can pin it, and must not be re-sliced as
  // if it were a listing row.
  assert('ruler is isolated', rendered.rulerHtml.includes('#* E I O op'));
  assert('ruler is not in the body', !rendered.bodyHtml.includes('#* E I O op'));
  assert('ruler is not in the preamble', !rendered.preambleHtml.includes('#* E I O op'));
  assert('listing rows are in the body', rendered.bodyHtml.includes('opc-name">ECHO'));
  assert('trailing branch summary is kept', rendered.bodyHtml.includes('branch: #'));

  // Shown/total now count listing lines only; preamble and ruler are always kept.
  check('body line count', rendered.total, 5);
  check('not truncated', rendered.truncated, false);

  const capped = renderOpcodeDump(dump, 2);
  check('cap applies to the listing', capped.shown, 2);
  check('total ignores the cap', capped.total, 5);
  check('truncation is reported', capped.truncated, true);
  assert('ruler survives the cap', capped.rulerHtml.includes('#* E I O op'));
  assert('omitted rows are announced', capped.bodyHtml.includes('3 more lines not shown'));

  // A dump with no ruler at all must not lose content.
  const headerless = renderOpcodeDump('a\nb\nc');
  check('headerless ruler is empty', headerless.rulerHtml, '');
  check('headerless preamble keeps everything', headerless.preambleHtml, 'a\nb\nc');
}

console.log('\n# 4. tab controller');
{
  function fakeEl(id, dataset = {}) {
    const el = {
      id,
      dataset,
      hidden: false,
      tabIndex: 0,
      attrs: {},
      classes: new Set(),
      listeners: {},
      classList: {
        add: (c) => el.classes.add(c),
        remove: (c) => el.classes.delete(c),
        toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
        contains: (c) => el.classes.has(c),
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      focus() { this.focused = true; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      fire(t, ev = {}) { (this.listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, ...ev })); },
    };
    return el;
  }

  const names = ['output', 'errors', 'opcodes'];
  const tabs = names.map((n) => {
    const el = fakeEl(`tab-${n}`, { resultTab: n });
    el.setAttribute('aria-controls', `panel-${n}`);
    return el;
  });
  const panels = names.map((n) => fakeEl(`panel-${n}`));
  const toolbars = names.map((n) => fakeEl(`tb-${n}`, { resultTabToolbar: n }));
  const activeIndex = () => tabs.findIndex((t) => t.classes.has('active'));

  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => panels.find((p) => p.id === id) || null };

  let api;
  try {
    api = setupResultTabs({
      querySelectorAll(sel) {
        if (sel === '[data-result-tab]') return tabs;
        if (sel === '[data-result-tab-toolbar]') return toolbars;
        return [];
      },
    });
  } finally {
    globalThis.document = previousDocument;
  }

  assert('controller created', api !== null);
  assert('output active initially', api.isActive('output'));
  assert('only one panel visible initially', panels.filter((p) => !p.hidden).length === 1);
  assert('roving tabindex applied', tabs[0].tabIndex === 0 && tabs[1].tabIndex === -1);

  api.show('opcodes');
  assert('target panel shown', panels[2].hidden === false);
  assert('others hidden', panels[0].hidden === true && panels[1].hidden === true);
  assert('only one panel visible', panels.filter((p) => !p.hidden).length === 1);
  assert('matching toolbar shown', toolbars[2].hidden === false && toolbars[0].hidden === true);
  check('aria-selected updated', tabs[2].getAttribute('aria-selected'), 'true');
  check('aria-selected cleared', tabs[0].getAttribute('aria-selected'), 'false');

  tabs[0].fire('click');
  assert('click activates', api.isActive('output'));
  assert('exactly one tab active', tabs.filter((t) => t.classes.has('active')).length === 1);

  api.show('output');
  tabs[activeIndex()].fire('keydown', { key: 'ArrowRight' });
  assert('ArrowRight', api.isActive('errors'));
  tabs[activeIndex()].fire('keydown', { key: 'ArrowRight' });
  assert('ArrowRight again', api.isActive('opcodes'));
  tabs[activeIndex()].fire('keydown', { key: 'ArrowRight' });
  assert('ArrowRight wraps', api.isActive('output'));
  tabs[activeIndex()].fire('keydown', { key: 'ArrowLeft' });
  assert('ArrowLeft wraps', api.isActive('opcodes'));
  tabs[activeIndex()].fire('keydown', { key: 'Home' });
  assert('Home', api.isActive('output'));
  tabs[activeIndex()].fire('keydown', { key: 'End' });
  assert('End', api.isActive('opcodes'));
  tabs[activeIndex()].fire('keydown', { key: 'a' });
  assert('other keys ignored', api.isActive('opcodes'));
  assert('focus moved with selection', tabs[2].focused === true);
}

console.log('\n# 5. diagnostic severity');
{
  const stderr = [
    'PHP Deprecated:  Automatic conversion of false to array is deprecated in /vld/x.php on line 3',
    'PHP Notice:  Undefined variable: $y in /vld/x.php on line 4',
    'PHP Warning:  Undefined array key "z" in /vld/x.php on line 5',
    'PHP Fatal error:  Uncaught Error: boom in /vld/x.php:9',
    'Stack trace:',
    '#0 /vld/x.php(9): {main}',
  ].join('\n');

  const summary = parseDiagnostics(stderr);
  check('all four counted', summary.total, 4);
  check('fatal', summary.counts.fatal, 1);
  check('warning', summary.counts.warning, 1);
  check('notice', summary.counts.notice, 1);
  check('deprecated', summary.counts.deprecated, 1);

  // The whole point: a fatal must outrank a page of deprecations.
  check('worst is fatal', summary.worst.key, 'fatal');
  check('badge is danger', summary.badgeClass, 'text-bg-danger');

  // Stack frames are context for the fatal, not new events.
  assert('stack frames are not counted', !summary.entries.some((e) => e.text.startsWith('#0')));

  check('summary reads most severe first', describeDiagnostics(summary), '1 error, 1 warning, 1 notice, 1 deprecation');

  // Badge colour must track the worst severity actually present.
  check('deprecation alone is not danger', parseDiagnostics('PHP Deprecated:  x in /a.php on line 1').badgeClass, 'text-bg-secondary');
  check('notice alone is info', parseDiagnostics('PHP Notice:  x in /a.php on line 1').badgeClass, 'text-bg-info');

  // A parse error means nothing ran; it is fatal in effect.
  check('parse error is fatal', parseDiagnostics('PHP Parse error:  syntax error in /a.php on line 1').counts.fatal, 1);
  check('strict standards are warnings', parseDiagnostics('PHP Strict Standards:  x in /a.php on line 1').counts.warning, 1);
  check('recoverable fatal is fatal', parseDiagnostics('PHP Recoverable fatal error:  x in /a.php on line 1').counts.fatal, 1);

  check('empty input', parseDiagnostics('').total, 0);
  check('null input', parseDiagnostics(null).total, 0);
  check('placeholder text is not a diagnostic', parseDiagnostics('No Errors!').total, 0);
  check('clean summary', describeDiagnostics(parseDiagnostics('')), 'No errors in the last run.');

  // Rendering tints per line, escapes everything, and preserves blank lines.
  const html = renderDiagnostics(stderr);
  assert('fatal line is tinted', html.includes('<span class="sev-fatal">PHP Fatal error'));
  assert('deprecation line is tinted', html.includes('<span class="sev-deprecated">PHP Deprecated'));
  assert('unclassified line is plain', html.includes('Stack trace:'));
  assert('no raw angle brackets', !html.replace(/<\/?span[^>]*>/g, '').includes('<'));

  // Regression guard for the WP-01.7 fix: a blank line in stderr must not be
  // dropped just because the neighbouring lines are now wrapped in spans.
  const withBlanks = renderDiagnostics('PHP Notice:  a\n\nPHP Warning:  b\n');
  assert('blank lines survive', withBlanks.includes('</span>\n\n<span'));

  // Anything a script writes to stderr that is not a diagnostic is escaped.
  const hostile = renderDiagnostics('<script>alert(1)</script>');
  assert('hostile stderr is escaped', !hostile.includes('<script>'));

  // Single diagnostic reads in the singular.
  check('singular', describeDiagnostics(parseDiagnostics('PHP Warning:  x in /a.php on line 1')), '1 warning');
}

console.log('\n# 6. getOpcodes against a real module');
{
  const createPhpModule = (await import(pathToFileURL(modulePath).href)).default;

  let stdoutSink = null;
  let stderrSink = null;
  let stdoutBuf = [];
  let stderrBuf = [];

  const mod = await createPhpModule({
    print: (d) => {
      if (d === undefined || d === null) return;
      if (stdoutSink) { stdoutSink(d); return; }
      if (stdoutBuf.length) stdoutBuf.push('\n');
      stdoutBuf.push(d);
    },
    printErr: (d) => {
      if (d === undefined || d === null) return;
      if (stderrSink) { stderrSink(d); return; }
      if (stderrBuf.length) stderrBuf.push('\n');
      stderrBuf.push(d);
    },
    onAbort: (reason) => { throw new Error(`WASM aborted: ${reason}`); },
  });

  const ccall = mod.ccall;
  const c = (name, type, args, values) => ccall(name, type, args, values);

  check('VLD is compiled in', c('phpw_exec', 'string', ['string'], ["extension_loaded('vld')?'yes':'no'"]), 'yes');

  // Mirrors PHP.getOpcodes() in playground/assets/js/playground.js. Both streams
  // are borrowed: VLD's table goes to stderr, branchinfo.c writes the branch
  // summary to stdout with bare printf().
  function getOpcodes(code, verbosity = 0) {
    const ok = c('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [1, 0, verbosity, 1]);
    if (ok !== 0) throw new Error(c('phpw_last_error', 'string', [], []) || 'config failed');

    const lines = [];
    const collect = (text) => lines.push(`${text}\n`);
    stdoutSink = collect;
    stderrSink = collect;

    let status = 0;
    try {
      try { mod.FS.mkdir('/vld'); } catch (e) { /* EEXIST */ }
      mod.FS.writeFile('/vld/code.php', code);
      status = c('phpw', null, ['string'], ['/vld/code.php']);
    } finally {
      stdoutSink = null;
      stderrSink = null;
      c('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 1, 1]);
      try { mod.FS.unlink('/vld/code.php'); } catch (e) { /* gone */ }
    }

    if (status !== 0) throw new Error(c('phpw_last_error', 'string', [], []) || 'compile failed');
    return lines.join('');
  }

  const dump = getOpcodes('<?php function t($x){ return $x * 2; } echo t(3);');
  assert('dump is produced', dump.length > 0);
  assert('dump names the staged file', dump.includes('/vld/code.php'));
  assert('dump contains opcodes', /\bECHO\b/.test(dump) && /\bINIT_FCALL\b/.test(dump));
  assert('branch summary captured from stdout', /branch: #/.test(dump));

  // Streams must be handed back, or ordinary runs would be polluted.
  stdoutBuf = [];
  stderrBuf = [];
  c('phpw_run', 'number', ['string'], ['?><?php echo "visible\n";']);
  check('stdout is clean after a dump', stdoutBuf.join('').trim(), 'visible');
  check('stderr is clean after a dump', stderrBuf.join(''), '');

  // The compile-only guarantee: side effects must not happen.
  const side = getOpcodes('<?php file_put_contents("/tmp/must-not-exist", "x"); echo "ran";');
  assert('side-effect snippet compiles', side.length > 0);
  check('side-effect snippet did not execute', mod.FS.analyzePath('/tmp/must-not-exist').exists, false);

  // A parse error must surface as an error, not as opcodes.
  let parseError = null;
  try { getOpcodes('<?php function {'); } catch (e) { parseError = e; }
  assert('parse error throws', parseError !== null);
  assert('parse error has a message', Boolean(parseError && parseError.message));

  // verbosity must actually change the output.
  const v0 = getOpcodes('<?php $a = 1; if ($a) { $b = 2; }', 0);
  const v1 = getOpcodes('<?php $a = 1; if ($a) { $b = 2; }', 1);
  assert('verbosity changes the dump', v0 !== v1);
  assert('verbosity 1 adds commentary', v1.includes('Branch analysis'));
  assert('verbosity 0 keeps the branch summary', /branch: #/.test(v0));

  check('out-of-range verbosity is refused', c('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 9, 1]) !== 0, true);

  // Repeated dumps must not accumulate state.
  let allOk = true;
  for (let i = 0; i < 50; i++) {
    if (getOpcodes(`<?php $i + $i;`).length === 0) allOk = false;
  }
  assert('50 consecutive dumps succeed', allOk);
  check('module still executes afterwards', c('phpw_exec', 'string', ['string'], ['1+1']), '2');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`);
if (failed.length) console.log('failed: ' + failed.join(', '));
process.exit(failures === 0 ? 0 : 1);