/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Multi-run: add a panel, run all, remove a panel.
 *
 * Every assertion goes through the panel ids multi-run.js generates. Each panel
 * owns a separate PHP module, so Run All over two panels downloads the WASM
 * twice -- the second panel's run is the slowest thing here.
 */

import { expect, test } from 'playwright/test'

import { multiEditorCode, openMultiRun, panelIds, setMultiEditorCode, waitForPanelRun } from './helpers.js'

test.describe('multi-run', () => {
    test('the shared editor mounts Monaco on load', async ({ page }) => {
        await openMultiRun(page)

        // The <div> replaces the markup <textarea>: CodeEditor.init() has to reach
        // initMonacoEditor(), which it did not while switchEditor() early-returned.
        await expect(page.locator('#editor')).toHaveJSProperty('tagName', 'DIV')
        await expect(page.locator('#editor .monaco-editor')).toBeVisible()
        await expect(page.locator('#editor-switcher')).toHaveValue('monaco')

        // The markup snippet is carried into the new editor.
        expect(await multiEditorCode(page)).toContain('phpversion')
    })

    test('switching the shared editor preserves its content', async ({ page }) => {
        await openMultiRun(page)
        await setMultiEditorCode(page, '<?php echo "multi editor";')

        await page.locator('#editor-switcher').selectOption('codemirror')
        await expect(page.locator('.CodeMirror')).toBeVisible()
        await expect.poll(() => multiEditorCode(page)).toBe('<?php echo "multi editor";')

        await page.locator('#editor-switcher').selectOption('monaco')
        await expect(page.locator('#editor .monaco-editor')).toBeVisible()
        await expect.poll(() => multiEditorCode(page)).toBe('<?php echo "multi editor";')
    })

    test('one panel is mounted, defaulted to the highest version', async ({ page }) => {
        await openMultiRun(page)

        expect(await panelIds(page)).toEqual(['1'])
        await expect(page.locator('#php-version-1')).toHaveText(/\d+\.\d+\.\d+/)
        await expect(page.locator('#version-select-1')).toHaveValue(/\d+\.\d+\.\d+/)
        await expect(page.locator('#output-1')).toHaveText('Ready!')
        await expect(page.locator('#error-1')).toHaveText('No Errors!')

        // multi.html loads timer.js as a module, so unlike index.html it boots
        // without the stray classic-script SyntaxError (WP-01.3) and has nothing to
        // excuse.
        expect(page.__pageErrors, 'unexpected console errors or page errors').toEqual([])
    })

    test('the add button appends another panel', async ({ page }) => {
        await openMultiRun(page)

        await page.locator('#add-version-button').click()
        expect(await panelIds(page)).toEqual(['1', '2'])

        // Each panel carries the full version list, not just the shared one.
        const options = await page.locator('#version-select-2 option').count()
        expect(options).toBeGreaterThan(2)
        await expect(page.locator('#version-select-2')).toHaveValue(
            await page.locator('#version-select-1').inputValue()
        )
    })

    test('run all executes the editor contents in every panel', async ({ page }) => {
        await openMultiRun(page)
        await page.locator('#add-version-button').click()
        expect(await panelIds(page)).toEqual(['1', '2'])

        await setMultiEditorCode(page, '<?php echo "shared code\\n";')
        await page.locator('#run-all-button').click()

        await waitForPanelRun(page, 1)
        await waitForPanelRun(page, 2)
        await expect(page.locator('#output-1')).toHaveText('shared code')
        await expect(page.locator('#output-2')).toHaveText('shared code')

        // Each panel reports the version it ran.
        await expect(page.locator('#php-version-1')).toHaveText(/\d+\.\d+\.\d+/)
        await expect(page.locator('#php-version-2')).toHaveText(/\d+\.\d+\.\d+/)
        // (The performance readout is not asserted: a one-echo script can finish
        // inside the 1ms resolution Timer.formatTime() rounds to, so "0ms" is a
        // legitimate outcome here.)

        // The run button is re-enabled afterwards, i.e. it is not stuck "Running...".
        await expect(page.locator('#run-button-1')).toBeEnabled()
        await expect(page.locator('#run-button-2')).toBeEnabled()
    })

    test('a single panel runs on its own version', async ({ page }) => {
        await openMultiRun(page)

        const versions = await page.$$eval('#version-select-1 option', options =>
            options.map(option => option.value).filter(Boolean)
        )
        expect(versions.length).toBeGreaterThan(1)

        await page.locator('#version-select-1').selectOption(versions[versions.length - 1])
        // The change handler runs immediately, so panel 1 is already running.
        await waitForPanelRun(page, 1)

        await expect(page.locator('#php-version-1')).toHaveText(versions[versions.length - 1])
    })

    test('a fatal error is visible in the panel that produced it', async ({ page }) => {
        await openMultiRun(page)
        await page.locator('#add-version-button').click()

        await setMultiEditorCode(page, '<?php\nnew NoSuchClass();\n')
        await page.locator('#run-all-button').click()

        await waitForPanelRun(page, 1)
        await waitForPanelRun(page, 2)

        // Diagnostics arrive on stdout and are split out per panel, so the fatal
        // belongs in the error area rather than in the program's output.
        await expect(page.locator('#error-1')).toContainText('Fatal error')
        await expect(page.locator('#error-2')).toContainText('Fatal error')
        await expect(page.locator('#error-1')).toContainText('NoSuchClass')
        await expect(page.locator('#output-1')).toHaveText('')
        await expect(page.locator('#output-2')).toHaveText('')
    })

    test('the remove button detaches its panel', async ({ page }) => {
        await openMultiRun(page)
        await page.locator('#add-version-button').click()
        await page.locator('#add-version-button').click()
        expect(await panelIds(page)).toEqual(['1', '2', '3'])

        await page.locator('#remove-button-2').click()
        expect(await panelIds(page)).toEqual(['1', '3'])

        // Run All must not touch the removed panel, and must not throw either.
        await setMultiEditorCode(page, '<?php echo "after removal\\n";')
        await page.locator('#run-all-button').click()
        await waitForPanelRun(page, 1)
        await waitForPanelRun(page, 3)
        await expect(page.locator('#output-1')).toHaveText('after removal')
        await expect(page.locator('#output-3')).toHaveText('after removal')
        await expect(page.locator('#output-2')).toHaveCount(0)
    })

    test('the editor and the panels stack on a narrow screen', async ({ page }) => {
        await openMultiRun(page)

        // multi.html used col-6 with no breakpoint, so below the lg breakpoint the
        // editor and the version panels were squeezed side by side into half a
        // phone each. Now that the navbar collapses, that page is reachable on a
        // phone and has to be usable.
        const stacked = async () =>
            page.evaluate(() => {
                const left = document.getElementById('left').getBoundingClientRect()
                const right = document.getElementById('right').getBoundingClientRect()
                return {
                    stacked: left.bottom <= right.top,
                    leftWidth: Math.round(left.width),
                    viewport: window.innerWidth
                }
            })

        await page.setViewportSize({ width: 480, height: 900 })
        await page.waitForTimeout(300)
        const narrow = await stacked()
        expect(narrow.stacked, 'the two columns should stack below the lg breakpoint').toBe(true)
        // Full width, not half. Not 100%: #main-container has m-4 and the row has
        // its own gutters.
        expect(narrow.leftWidth).toBeGreaterThan(narrow.viewport * 0.8)

        await page.setViewportSize({ width: 1280, height: 900 })
        await page.waitForTimeout(300)
        const wide = await stacked()
        expect(wide.stacked, 'the two columns should sit side by side above it').toBe(false)
        expect(wide.leftWidth).toBeLessThan(wide.viewport * 0.6)
    })

    test('the example dropdown loads a snippet into the shared editor', async ({ page }) => {
        await openMultiRun(page)

        await page.locator('#php-example-switcher').selectOption('hello_world')
        await expect.poll(() => multiEditorCode(page)).toContain('<?php')

        // The panels read whatever the shared editor holds at run time, so the
        // observable effect is the snippet running everywhere.
        await page.locator('#run-all-button').click()
        await waitForPanelRun(page, 1)
        await expect(page.locator('#output-1')).toContainText('Hello, World!')
    })
})
