/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Examples: the example dropdown lists examples/examples.json and loads the
 * chosen snippet into the editor.
 *
 * Off github.io the pages fetch examples/_get_file.php?file=<name>, not the
 * .php file itself -- a browser fetching hello_world.php from a PHP server would
 * execute it. tests/server.mjs implements that endpoint, so this spec also covers
 * the route the test server has to get right (WP-06 infrastructure, not app code).
 */

import { expect, test } from 'playwright/test'

import { editorCode, errorText, openPlayground, outputText, runCode, setEditorCode } from './helpers.js'

test.describe('examples', () => {
    test('the dropdown is populated from examples.json', async ({ page }) => {
        await openPlayground(page)

        const listed = await page.evaluate(async () =>
            (await (await fetch('examples/examples.json')).json()).map(entry => entry.value)
        )

        const options = await page.$$eval('#php-example-switcher option', nodes =>
            nodes.map(node => node.value).filter(Boolean)
        )

        expect(options).toEqual(listed)

        // Placeholder first, and it is not a selectable value.
        const first = page.locator('#php-example-switcher option').first()
        await expect(first).toHaveAttribute('value', '')
        await expect(first).toBeDisabled()
    })

    test('every listed example loads into the editor', async ({ page }) => {
        await openPlayground(page)

        const listed = await page.evaluate(async () =>
            (await (await fetch('examples/examples.json')).json()).map(entry => entry.value)
        )

        for (const name of listed) {
            // Compare against the file the endpoint actually serves rather than
            // looking for "<?php": every example contains that, so a poll on it is
            // satisfied by the *previous* example and proves nothing about this one.
            const expected = await (await page.request.get(`/examples/_get_file.php?file=${name}`)).text()
            await page.locator('#php-example-switcher').selectOption(name)
            await expect.poll(() => editorCode(page), { message: `example "${name}" was not loaded` }).toBe(expected)
        }
    })

    test('the endpoint serves the snippet, not the endpoint', async ({ page, request }) => {
        await openPlayground(page)

        const response = await request.get('/examples/_get_file.php?file=hello_world')
        expect(response.status()).toBe(200)
        const body = await response.text()
        expect(body).toContain('<?php')
        // The whole point of _get_file.php: the source of the endpoint itself must
        // never reach the editor.
        expect(body).not.toContain('return_file_as_plaintext')
    })

    test('the endpoint rejects anything outside the examples directory', async ({ page, request }) => {
        await openPlayground(page)

        // The encoded traversal is built at run time so the literal does not sit in
        // the source: the point is what the server does with it, not how it is typed.
        for (const attempt of ['../index', encodeURIComponent('../version'), '_get_file', 'does_not_exist', '']) {
            const response = await request.get(`/examples/_get_file.php?file=${attempt}`)
            expect([400, 404], `file=${attempt}`).toContain(response.status())
        }

        expect((await request.get('/examples/_get_file.php')).status()).toBe(400)
    })

    test('a loaded example runs', async ({ page }) => {
        await openPlayground(page)

        await page.locator('#php-example-switcher').selectOption('hello_world')
        await expect.poll(() => editorCode(page)).toContain('<?php')

        await runCode(page)
        expect(await outputText(page)).toContain('Hello')
        expect((await errorText(page)).trim()).toBe('No Errors!')
    })

    test('the phpinfo example switches the output to HTML mode', async ({ page }) => {
        await openPlayground(page)

        await expect(page.locator('#output-mode-switcher')).not.toBeChecked()
        await page.locator('#php-example-switcher').selectOption('phpinfo')
        await expect(page.locator('#output-mode-switcher')).toBeChecked()

        await runCode(page)
        // Rendered as HTML: phpinfo() emits real markup, so the panel must contain
        // elements rather than escaped angle brackets. (<html>/<head>/<body> are
        // dropped by the HTML parser inside a <pre>, so look for the tables.)
        await expect(page.locator('#standard-output table').first()).toBeAttached()

        // Any other example turns the mode back off.
        await page.locator('#php-example-switcher').selectOption('json')
        await expect(page.locator('#output-mode-switcher')).not.toBeChecked()
    })

    test('reset restores the hello world example and clears the panels', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php echo "scratch\\n";')
        await runCode(page)
        expect(await outputText(page)).toContain('scratch')

        await page.locator('#reset-button').click()

        await expect.poll(() => editorCode(page)).toContain('Hello')
        // Reset writes the empty string, not the "Ready!" placeholder.
        await expect(page.locator('#standard-output')).toHaveText('')
        await expect(page.locator('#standard-error-output')).toHaveText('No Errors!')
    })
})
