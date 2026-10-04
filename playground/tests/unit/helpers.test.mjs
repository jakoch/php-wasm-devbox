/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Unit tests for the playground's pure helpers: no browser, no WASM, no
 * dependency beyond Node's own test runner (npm run test:unit).
 *
 * These are the functions where a regression is silent -- nothing on the page
 * fails loudly if the version list stops sorting or an error line comes out
 * wrong, the user just gets a worse playground.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Timer } from '../../assets/js/timer.js'
import {
  basePathFor,
  classifyDiagnostic,
  compareVersions,
  describeDiagnostics,
  parseDiagnostics,
  parsePhpError
} from '../../assets/js/playground.js'

describe('basePathFor', () => {
  it('returns the directory the page lives in, whatever it is called', () => {
    // WASM module URLs hang off this. The previous implementation matched a
    // hardcoded /php-wasm-devbox prefix, so every fork and rename 404'd on the
    // module and the playground could not run at all.
    assert.equal(basePathFor('/playground/index.html'), '/playground')
    assert.equal(basePathFor('/index.html'), '')
    assert.equal(basePathFor('/'), '')
  })

  it('works for a subdirectory deployment', () => {
    assert.equal(basePathFor('/jakoch/php-wasm-devbox/'), '/jakoch/php-wasm-devbox')
    assert.equal(basePathFor('/jakoch/php-wasm-devbox/index.html'), '/jakoch/php-wasm-devbox')
    assert.equal(basePathFor('/a/b/c/multi.html'), '/a/b/c')
  })

  it('treats a slash-less URL that is not a file as a directory', () => {
    // At "/my-repo" a relative URL resolves against "/", so the module would be
    // requested from /assets/wasm/... instead of /my-repo/assets/wasm/...
    assert.equal(basePathFor('/my-repo'), '/my-repo')
    assert.equal(basePathFor('/jakoch/php-wasm-devbox'), '/jakoch/php-wasm-devbox')
  })

  it('copes with a missing pathname', () => {
    assert.equal(basePathFor(undefined), '')
    assert.equal(basePathFor(''), '')
  })
})

describe('compareVersions', () => {
  it('sorts descending, which is the order the dropdown wants', () => {
    const sorted = ['8.4.26', '8.5.11', '8.4.9', '8.10.0'].sort(compareVersions)
    // 8.10.0 is newer than 8.5.11 and must come first; the two 8.4 patches keep
    // their patch order.
    assert.deepEqual(sorted, ['8.10.0', '8.5.11', '8.4.26', '8.4.9'])
  })

  it('is a comparator, not a boolean', () => {
    // loadPhpVersions() hands it straight to Array#sort, so a sign is required.
    assert.ok(compareVersions('8.5.11', '8.4.26') < 0, 'newer first')
    assert.ok(compareVersions('8.4.26', '8.5.11') > 0, 'older second')
    assert.equal(compareVersions('8.5.11', '8.5.11'), 0)
  })

  it('compares numerically, not as strings', () => {
    // '10' < '9' as strings, so a lexicographic sort would put 8.10.0 below
    // 8.4.9 and hide the newest minor.
    assert.ok(compareVersions('8.10.0', '8.9.0') < 0)
    assert.ok(compareVersions('8.9.0', '8.10.0') > 0)
  })

  it('treats a missing segment as zero', () => {
    assert.ok(compareVersions('8.5', '8.5.0') === 0, '8.5 and 8.5.0 are the same release')
    assert.ok(compareVersions('8.5.1', '8.5') < 0)
    assert.ok(compareVersions('8.5', '8.5.1') > 0)
  })

  it('does not treat a NaN segment as equal to anything', () => {
    // Number('dev') is NaN and `NaN || 0` is 0, so an unparsable version
    // collapses to 0.0 instead of poisoning the sort with NaN comparisons.
    assert.equal(compareVersions('dev', '0.0.0'), 0)
    assert.ok(compareVersions('8.5.11', '8.5.x-dev') < 0)
  })
})

describe('parsePhpError', () => {
  it('extracts the line number from a parse error', () => {
    const info = parsePhpError('Parse error: syntax error, unexpected identifier "is" in /run/script.php on line 4')
    assert.deepEqual(info, {
      line: 4,
      message: 'Parse error: syntax error, unexpected identifier "is" in /run/script.php on line 4'
    })
  })

  it('finds the line of a fatal error reported in the stack trace', () => {
    // PHP prints "Fatal error: ... in /run/script.php:3" and only mentions the
    // line again in the trailing "thrown in ... on line 3".
    const stderr = [
      'Fatal error: Uncaught Error: Class "Nope" not found in /run/script.php:3',
      'Stack trace:',
      '#0 {main}',
      '  thrown in /run/script.php on line 3'
    ].join('\n')
    assert.equal(parsePhpError(stderr).line, 3)
  })

  it('trims the trailing "in script" noise from the message', () => {
    const info = parsePhpError('PHP Parse error: syntax error, unexpected end of file in script on line 12')
    assert.equal(info.line, 12)
    assert.equal(info.message, 'PHP Parse error: syntax error, unexpected end of file')
  })

  it('keeps only the first line of the message', () => {
    const info = parsePhpError('Warning: boom in /run/script.php on line 2\nStack trace:\n#0 {main}')
    assert.equal(info.line, 2)
    assert.equal(info.message, 'Warning: boom in /run/script.php on line 2')
  })

  it('falls back to line 1 when there is a diagnostic but no line number', () => {
    const info = parsePhpError('PHP Fatal error: something went wrong')
    assert.deepEqual(info, { line: 1, message: 'PHP Fatal error: something went wrong' })
  })

  it('skips the leading newline PHP puts in front of a diagnostic', () => {
    // Both marker backends drop a marker with an empty message -- Monaco's
    // MarkerService stores none, CodeMirror renders a span with no tooltip -- so
    // taking split('\n')[0] here meant a parse error produced no marker at all.
    const info = parsePhpError('\nParse error: syntax error, unexpected identifier "is" in /run/script.php on line 4')
    assert.equal(info.line, 4)
    assert.ok(info.message.length > 0, 'the marker message must not be empty')
    assert.match(info.message, /Parse error/)

    // More than one leading blank line, and blank lines between diagnostics.
    const padded = parsePhpError('\n\n\nFatal error: Uncaught Error: boom in /run/script.php:7\n\nStack trace:')
    assert.equal(padded.message, 'Fatal error: Uncaught Error: boom in /run/script.php:7')
  })

  it('returns null for clean output, so no marker is drawn', () => {
    assert.equal(parsePhpError(''), null)
    assert.equal(parsePhpError(null), null)
    assert.equal(parsePhpError(undefined), null)
    // Real program output must not be mistaken for a diagnostic.
    assert.equal(parsePhpError('Hello, World!'), null)
    assert.equal(parsePhpError('a fatal-looking word'), null)
  })
})

describe('classifyDiagnostic', () => {
  it('recognises the four severities, with or without the log prefix', () => {
    // The `PHP ` prefix comes from error_log, not display_errors, so the version
    // of these patterns that required it matched nothing at all.
    for (const [text, key] of [
      ['Warning: boom in /a.php on line 2', 'warning'],
      ['PHP Warning:  boom in /a.php on line 2', 'warning'],
      ['Notice: boom in /a.php on line 2', 'notice'],
      ['Deprecated: boom in /a.php on line 2', 'deprecated'],
      ['Parse error: syntax error in /a.php on line 2', 'fatal'],
      ['Recoverable fatal error: boom in /a.php:2', 'fatal']
    ]) {
      const classified = classifyDiagnostic(text)
      assert.equal(classified?.key, key, text)
    }
  })

  it('needs a file-and-line reference, which program output has no reason to carry', () => {
    assert.equal(classifyDiagnostic('Notice: all good'), null)
    assert.equal(classifyDiagnostic('Warning: I am program output'), null)
    assert.equal(classifyDiagnostic('Fatal error: my program says this'), null)
  })

  it('rejects blanks and the panel placeholder', () => {
    assert.equal(classifyDiagnostic(''), null)
    assert.equal(classifyDiagnostic('   '), null)
    assert.equal(classifyDiagnostic('No Errors!'), null)
    // Stack frames are context, not separate events.
    assert.equal(classifyDiagnostic('#0 /run/script.php(3): {main}'), null)
    assert.equal(classifyDiagnostic('  thrown in /run/script.php on line 3'), null)
  })
})

describe('parseDiagnostics', () => {
  it('counts unclassified error text as one error, not zero', () => {
    // A module that will not load produces no PHP diagnostic, but the badge and
    // the live region still have to point at a non-empty Errors panel.
    const summary = parseDiagnostics('PHP execution failed: Failed to fetch dynamically imported module')
    assert.equal(summary.total, 1)
    assert.equal(summary.badgeClass, 'text-bg-danger')
    assert.equal(describeDiagnostics(summary), '1 error')
  })

  it('still reports nothing for the empty and placeholder cases', () => {
    assert.equal(parseDiagnostics('').total, 0)
    assert.equal(parseDiagnostics(null).total, 0)
    assert.equal(parseDiagnostics('No Errors!').total, 0)
    assert.equal(parseDiagnostics('   \n  ').total, 0)
  })

  it('counts severities across a stderr blob', () => {
    // What the module actually delivers on stderr now that the streams are
    // separated: diagnostics only, no program output.
    const stderr = [
      'PHP Deprecated:  old in /a.php on line 1',
      'PHP Warning:  x in /a.php on line 2',
      'Fatal error: boom in /a.php:3',
      'Stack trace:',
      '#0 {main}',
      '  thrown in /a.php on line 3'
    ].join('\n')
    const summary = parseDiagnostics(stderr)
    assert.equal(summary.total, 3)
    assert.equal(summary.worst.key, 'fatal')
    assert.equal(describeDiagnostics(summary), '1 error, 1 warning, 1 deprecation')
    // Frames are context, not events.
    assert.ok(!summary.entries.some(entry => entry.text.startsWith('#0')))
  })
})

describe('Timer.formatTime', () => {
  it('formats sub-second values as milliseconds', () => {
    assert.equal(Timer.formatTime(0), '0ms')
    assert.equal(Timer.formatTime(1), '1ms')
    assert.equal(Timer.formatTime(999.4), '999ms')
  })

  it('formats seconds and milliseconds together', () => {
    assert.equal(Timer.formatTime(1000), '1s 0ms')
    assert.equal(Timer.formatTime(1500.6), '1s 500ms')
    assert.equal(Timer.formatTime(59_999), '59s 999ms')
  })

  it('formats minutes and seconds together', () => {
    assert.equal(Timer.formatTime(60_000), '1m 0s')
    assert.equal(Timer.formatTime(90_000), '1m 30s')
  })

  it('has an unusable seconds unit, which is why nobody passes it', () => {
    // formatTime(ms, 's') divides by 1000 and then applies the millisecond
    // thresholds, so 1500ms comes out as "2ms". Both call sites use the default
    // 'ms', so this is latent rather than user-visible; pinned here so that
    // fixing it is a deliberate change to this assertion and not a surprise.
    assert.equal(Timer.formatTime(1500, 's'), '2ms')
    assert.equal(Timer.formatTime(90_000, 's'), '90ms')
  })

  it('truncates rather than rounds up past the unit boundary', () => {
    // A run that took 999.6ms must not be reported as "1s 0ms".
    assert.equal(Timer.formatTime(999.6), '1000ms')
    assert.equal(Timer.formatTime(59_999.9), '59s 999ms')
  })

  it('rejects values that are not finite numbers', () => {
    assert.throws(() => Timer.formatTime(Number.NaN), /Invalid time value/)
    assert.throws(() => Timer.formatTime(Number.POSITIVE_INFINITY), /Invalid time value/)
    assert.throws(() => Timer.formatTime('12'), /Invalid time value/)
  })
})
