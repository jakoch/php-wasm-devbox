/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Smoke: the page boots, the version list populates, and PHP actually runs.
 *
 * Catches the failures a diff review would not: a mistyped asset path, a missing
 * .wasm, a dropdown that never gets filled.
 */

import { expect, test } from 'playwright/test'

import {
    editorCode,
    errorText,
    openPlayground,
    outputText,
    runCode,
    selectedVersion,
    setEditorCode,
    versionOptions
} from './helpers.js'

test.describe('smoke', () => {
    test('page loads and boots the debug surface', async ({ page }) => {
        await openPlayground(page)

        await expect(page).toHaveTitle(/PHP-WASM/i)
        await expect(page.locator('h1').first()).toBeVisible()
        await expect(page.locator('#run-button')).toBeVisible()
        await expect(page.locator('#editor')).toBeVisible()

        // version.json is fetched on boot and rendered into the footer.
        await expect(page.locator('#app-version')).toHaveText(/PHP-WASM Playground v\d+\.\d+\.\d+ #\w+/)
    })

    test('version dropdown is populated from php-versions.json', async ({ page }) => {
        await openPlayground(page)

        const options = await versionOptions(page)
        expect(options.length).toBeGreaterThan(0)
        // Every option is a real version, not the "Select Version" placeholder.
        for (const version of options) expect(version).toMatch(/^\d+\.\d+\.\d+$/)

        // The options are the file's contents, and the dropdown defaults to the
        // first one (compareVersions sorts descending).
        const listed = await page.evaluate(async () =>
            (await (await fetch('assets/wasm/php-versions.json')).json()).map(String)
        )
        expect([...options].sort()).toEqual([...listed].sort())
        expect(await selectedVersion(page)).toBe(options[0])

        // The label is prefixed, the value is not.
        await expect(page.locator('#php-version-switcher option', { hasText: /^PHP \d+\.\d+\.\d+$/ })).toHaveCount(
            options.length
        )
    })

    test('a listed version has a downloadable module', async ({ page }) => {
        await openPlayground(page)

        // The dropdown is built from a JSON file, not from the folder, so a version
        // can be listed without its module existing -- which is a 404 in the
        // browser rather than a build failure. Check the pair exists.
        for (const version of await versionOptions(page)) {
            for (const extension of ['mjs', 'wasm']) {
                const response = await page.request.get(`/assets/wasm/php-${version}-web.${extension}`)
                expect(response.status(), `php-${version}-web.${extension}`).toBe(200)
            }
        }
    })

    test('hello world runs and reports the version and a duration', async ({ page }) => {
        await openPlayground(page)
        const version = await selectedVersion(page)

        await setEditorCode(page, '<?php echo "Hello World!\\n";')
        await runCode(page)

        expect(await outputText(page)).toBe('Hello World!')
        // stderr is empty for a clean script, so the panel keeps its placeholder.
        expect((await errorText(page)).trim()).toBe('No Errors!')

        // phpversion() of a development build carries the "-dev" suffix, so match
        // on the selected version being a prefix of what the engine reported.
        const reported = (await page.locator('#php-version').textContent()).trim()
        expect(reported.startsWith(version), `engine reported ${reported}, selected ${version}`).toBe(true)
        await expect(page.locator('#perf-data')).not.toHaveText('0ms')
    })

    test('blank lines in the output are preserved', async ({ page }) => {
        await openPlayground(page)

        // The WP-01.7 regression: empty chunks used to be dropped.
        await setEditorCode(page, '<?php echo "one\\n\\ntwo\\n\\n\\nthree\\n";')
        await runCode(page)

        expect(await outputText(page)).toBe('one\n\ntwo\n\n\nthree')
    })

    test('output without a trailing newline is delivered', async ({ page }) => {
        await openPlayground(page)

        // WP-01.10: Emscripten only calls print() when it sees a newline, so the
        // bridge has to drain that buffer explicitly. This test fails against a
        // module built before the fix -- the panel comes back empty, and the text
        // turns up in the *next* run instead.
        await setEditorCode(page, '<?php echo "no trailing newline";')
        await runCode(page)
        expect(await outputText(page)).toBe('no trailing newline')

        // And it must not bleed into the following run either.
        await setEditorCode(page, '<?php echo "second run";')
        await runCode(page)
        expect(await outputText(page)).toBe('second run')
    })

    test('navigation reaches the multi-run page and the help panel', async ({ page }) => {
        await openPlayground(page)

        await expect(page.locator('#playground-link')).toHaveClass(/active/)
        await expect(page.locator('#multi-run-link')).toHaveAttribute('href', 'multi.html')

        // The help panel is toggled in place, so it must start hidden and must
        // become visible on click.
        await expect(page.locator('#help-container')).toBeHidden()
        await page.locator('#help-link').click()
        await expect(page.locator('#help-container')).toBeVisible()
        await page.locator('#playground-link').click()
        await expect(page.locator('#help-container')).toBeHidden()

        await page.locator('#multi-run-link').click()
        await page.waitForURL(/multi\.html$/)
        await expect(page.locator('#version-panels-container')).toBeVisible()
    })

    test('the page boots and runs without script errors', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php echo "clean boot";')
        await runCode(page)

        // No filter: index.html used to load timer.js as a classic script although it
        // is an ES module, which threw "Unexpected token 'export'" on every load.
        expect(page.__pageErrors, 'unexpected console errors, page errors or failed requests').toEqual([])
    })

    test('it works when served from a subdirectory', async ({ page }) => {
        // The deployment that GitHub Pages actually serves: the site sits under
        // /owner/repo/, so every WASM module URL has to carry that prefix. The
        // previous implementation matched a hardcoded /php-wasm-devbox and 404'd on
        // every module here, which is what a fork of this repo hit.
        await openPlayground(page, '/my-fork/my-repo/playground/index.html')

        expect(await page.evaluate(() => location.pathname)).toBe('/my-fork/my-repo/playground/index.html')

        await setEditorCode(page, '<?php echo "from a subdirectory\\n";')
        await runCode(page)

        // A run needs the module, so this fails outright if the base path is wrong.
        expect(await outputText(page)).toBe('from a subdirectory')
        expect((await errorText(page)).trim()).toBe('No Errors!')
    })

    test('it works when reached at a URL with no trailing slash', async ({ page }) => {
        // Every real static host redirects a slash-less directory to the slashed
        // form; tests/server.mjs does too. The page then has to work at whatever URL
        // it ended up on, which is the part that is ours.
        const response = await page.goto('/my-fork/my-repo/playground')

        // goto() follows the redirect, so the first hop is on the request.
        expect(response.request().redirectedFrom()?.url()).toContain('/my-fork/my-repo/playground')
        expect(page.url()).toContain('/my-fork/my-repo/playground/')

        await page.waitForFunction(() => Boolean(window.phpPlayground))
        await setEditorCode(page, '<?php echo "after the redirect\\n";')
        await runCode(page)
        expect(await outputText(page)).toBe('after the redirect')
    })

    test('the editor starts with the bundled example and the status bar follows it', async ({ page }) => {
        await openPlayground(page)

        // index.html ships a starting snippet; Monaco inherits it.
        const initial = await editorCode(page)
        expect(initial).toContain('phpversion()')

        await expect(page.locator('#statusbar-size')).toHaveText(`Size: ${initial.length} bytes`)
        await expect(page.locator('#statusbar-cursor')).toHaveText('Ln: 1, Col: 1')

        await setEditorCode(page, '<?php // 12 chars')
        await expect(page.locator('#statusbar-size')).toHaveText(`Size: ${'<?php // 12 chars'.length} bytes`)
    })
})
