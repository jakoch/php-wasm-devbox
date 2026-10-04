/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Errors: a PHP diagnostic must be shown to the user and land on the right
 * editor line as a marker.
 *
 * The marker matters most -- it is the only feedback about *where* the error is,
 * and setEditorErrorMarker() has two independent implementations (Monaco
 * markers, CodeMirror marked ranges).
 *
 * The panel split is pinned here too: the module keeps diagnostics on stderr
 * and program output on stdout, so each panel gets exactly one of them.
 */

import { expect, test } from 'playwright/test'

import { errorText, openPlayground, runCode, setEditorCode } from './helpers.js'

/**
 * Read the markers the playground set on the editor, independently of the backend.
 * CodeMirror has no marker API, so it gets a `php-error-marker` span instead --
 * hence the differing shape and the `kind` field.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<{kind: string, line: number|null, message: string}>>}
 */
function editorMarkers(page) {
    return page.evaluate(() => {
        const playground = window.phpPlayground
        if (playground.editor.currentEditor === 'monaco') {
            const model = window.monaco.editor.getModels()[0]
            return window.monaco.editor.getModelMarkers({ resource: model.uri }).map(marker => ({
                kind: 'monaco',
                line: marker.startLineNumber,
                message: marker.message
            }))
        }
        return Array.from(document.querySelectorAll('.CodeMirror .php-error-marker')).map(node => ({
            kind: 'codemirror',
            // CodeMirror exposes no line number on the span; callers assert on the
            // count and the title instead.
            line: null,
            message: node.title
        }))
    })
}

test.describe('errors', () => {
    test('a parse error is shown and marked on the offending line', async ({ page }) => {
        await openPlayground(page)

        // Nothing runs, so there is no program output at all.
        await setEditorCode(page, '<?php\n\necho "start";\nthis is not php;\n')
        await runCode(page)

        await expect(page.locator('#standard-output')).toHaveText('')
        await expect(page.locator('#standard-error-output')).toContainText('Parse error')
        await expect(page.locator('#standard-error-output')).toContainText('syntax error')

        // The badge counts diagnostic lines and is hidden while there are none.
        const badge = page.locator('#error-badge')
        await expect(badge).toBeVisible()
        await expect(badge).toHaveText('1')

        // The marker points at the line PHP objected to, which is line 4.
        const markers = await editorMarkers(page)
        expect(markers).toHaveLength(1)
        expect(markers[0].kind).toBe('monaco')
        expect(markers[0].line).toBe(4)
        expect(markers[0].message).toMatch(/syntax error/i)

        // The Output tab gets a passive banner; the tab itself is never switched to.
        await expect(page.locator('#output-alert-banner')).toBeVisible()
        await expect(page.locator('#panel-errors')).toBeHidden()
        await expect(page.locator('#error-badge-live')).toHaveText('1 error')
    })

    test('a fatal error is shown and marked on its own line', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php\necho "before\\n";\nnew NoSuchClass();\necho "after\\n";\n')
        await runCode(page)

        // Output before the fatal stays in Output; the fatal and its trace move to Errors.
        expect(await page.locator('#standard-output').textContent()).toBe('before')
        const errors = await page.locator('#standard-error-output').textContent()
        expect(errors).toContain('Fatal error')
        expect(errors).toContain('NoSuchClass')
        expect(errors).toContain('Stack trace:')

        const markers = await editorMarkers(page)
        expect(markers.map(marker => marker.line)).toEqual([3])
        // The tooltip is the first non-blank diagnostic line, not the program's output.
        expect(markers[0].message).not.toBe('')
    })

    test('markers are cleared by a subsequent clean run', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php\nbroken(\n')
        await runCode(page)
        expect(await editorMarkers(page)).toHaveLength(1)

        await setEditorCode(page, '<?php echo "fine\\n";')
        await runCode(page)

        expect(await editorMarkers(page)).toHaveLength(0)
        expect(await page.locator('#standard-output').textContent()).toBe('fine')
    })

    test('markers are cleared by the reset button', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php\nbroken(\n')
        await runCode(page)
        expect(await editorMarkers(page)).toHaveLength(1)

        await page.locator('#reset-button').click()
        await expect.poll(() => editorMarkers(page)).toHaveLength(0)
    })

    test('a CodeMirror run marks the error line as a styled range', async ({ page }) => {
        await openPlayground(page)

        await page.locator('#editor-switcher').selectOption('codemirror')
        await expect(page.locator('.CodeMirror')).toBeVisible()

        await setEditorCode(page, '<?php\n\necho "start";\nthis is not php;\n')
        await runCode(page)

        expect(await page.locator('#standard-error-output').textContent()).toContain('Parse error')

        // CodeMirror has no marker API; the playground marks the line with a class
        // carrying the message as its tooltip. This is the other half of the pair.
        await expect(page.locator('.CodeMirror .php-error-marker')).toHaveCount(1)
        await expect(page.locator('.CodeMirror .php-error-marker')).toHaveAttribute('title', /syntax error|unexpected/i)
    })

    test('markers survive a switch to the other editor only after the next run', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php\n\necho "start";\nthis is not php;\n')
        await runCode(page)
        expect(await editorMarkers(page)).toHaveLength(1)

        // switchEditor() clears the old backend's marks and nothing re-applies the
        // diagnostic to the new one, so the marker is gone until the next run.
        await page.locator('#editor-switcher').selectOption('codemirror')
        await expect(page.locator('.CodeMirror')).toBeVisible()
        expect(await editorMarkers(page)).toHaveLength(0)

        await setEditorCode(page, '<?php\n\necho "start";\nthis is not php;\n')
        await runCode(page)
        expect(await editorMarkers(page)).toHaveLength(1)
    })

    test('program output is not injected as markup in raw mode', async ({ page }) => {
        await openPlayground(page)

        // Raw mode writes with textContent, so a script that echoes markup cannot
        // put elements into the live document (WP-09).
        await setEditorCode(page, '<?php echo "<img id=injected src=x>\\n";')
        await runCode(page)

        await expect(page.locator('#standard-output img#injected')).toHaveCount(0)
        expect(await page.locator('#standard-output').textContent()).toContain('<img id=injected src=x>')

        // HTML mode is the one that renders it, which is the whole point of the
        // toggle.
        await page.locator('#output-mode-switcher').check()
        await expect(page.locator('#standard-output img#injected')).toHaveCount(1)
    })

    test('the result tabs switch between Output, Errors and Opcodes', async ({ page }) => {
        await openPlayground(page)

        await expect(page.locator('#panel-output')).toBeVisible()
        await expect(page.locator('#panel-errors')).toBeHidden()
        await expect(page.locator('#panel-opcodes')).toBeHidden()

        await page.locator('#tab-errors').click()
        await expect(page.locator('#panel-errors')).toBeVisible()
        await expect(page.locator('#tab-errors')).toHaveAttribute('aria-selected', 'true')
        await expect(page.locator('#panel-output')).toBeHidden()

        // Arrow keys move between tabs, because Bootstrap's JS bundle is not loaded
        // on this page and data-bs-toggle does nothing.
        await page.locator('#tab-errors').press('ArrowRight')
        await expect(page.locator('#panel-opcodes')).toBeVisible()
        await page.locator('#tab-opcodes').press('ArrowRight')
        await expect(page.locator('#panel-output')).toBeVisible()
        await expect(page.locator('#tab-errors')).toHaveAttribute('aria-selected', 'false')
    })

    test('a failing version load is reported and the selection is restored', async ({ page }) => {
        await openPlayground(page)
        const good = await page.locator('#php-version-switcher').inputValue()

        // A version that is selectable but has no module behind it: the dropdown is
        // filled from JSON, so this is exactly what a stale entry looks like.
        await page.evaluate(() => {
            const dropdown = document.getElementById('php-version-switcher')
            dropdown.appendChild(new Option('PHP 9.9.9', '9.9.9'))
        })
        await page.locator('#php-version-switcher').selectOption('9.9.9')

        // The failure is a JS-side error, so this one does land in the Errors panel.
        await expect(page.locator('#standard-error-output')).toContainText('PHP execution failed')
        await expect(page.locator('#error-badge')).toBeVisible()

        // WP-01.9: a failed select must not stay selected, or every later run fails.
        await expect(page.locator('#php-version-switcher')).toHaveValue(good)

        // ... and the next run works.
        await setEditorCode(page, '<?php echo "still fine\\n";')
        await runCode(page)
        expect(await page.locator('#standard-output').textContent()).toBe('still fine')
    })

    test('the Errors panel keeps its placeholder while PHP stays quiet', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php echo "all good\\n";')
        await runCode(page)

        expect(await page.locator('#standard-output').textContent()).toBe('all good')
        expect((await errorText(page)).trim()).toBe('No Errors!')
        await expect(page.locator('#error-badge')).toBeHidden()
    })

    test('a warning goes to the Errors panel, not the Output panel', async ({ page }) => {
        await openPlayground(page)

        // PHP prints a blank line before the diagnostic; it must not trail the output.
        await setEditorCode(page, '<?php echo "before\\n"; trigger_error("boom", E_USER_WARNING); echo "after\\n";')
        await runCode(page)

        expect(await page.locator('#standard-output').textContent()).toBe('before\nafter')
        expect(await errorText(page)).toContain('Warning: boom')
        await expect(page.locator('#error-badge')).toHaveText('1')
        await expect(page.locator('#error-badge-live')).toHaveText('1 warning')
    })

    test('program output that reads like a diagnostic stays program output', async ({ page }) => {
        await openPlayground(page)

        // The classification still needs a file-and-line reference, so this is not
        // counted in the badge even if a script writes it to stderr itself.
        await setEditorCode(page, '<?php echo "Notice: all good\\n"; echo "Warning: also fine\\n";')
        await runCode(page)

        expect(await page.locator('#standard-output').textContent()).toBe('Notice: all good\nWarning: also fine')
        expect((await errorText(page)).trim()).toBe('No Errors!')
        await expect(page.locator('#error-badge')).toBeHidden()
    })
})
