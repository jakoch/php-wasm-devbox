/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Toolbar: the Load / Save / Copy buttons and the Ctrl+S / Ctrl+C shortcuts.
 *
 * All five existed in index.html and did nothing on this page -- they were only
 * wired up in multi-run.js -- while the Help panel advertised the two shortcuts
 * and the readme claimed Save was done.
 */

import { expect, test } from 'playwright/test'

import { openPlayground, setEditorCode } from './helpers.js'

const CODE = '<?php echo "toolbar";'

/** Grant clipboard access before the page loads; the API needs a permission. */
async function openWithClipboard(page) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openPlayground(page)
    await setEditorCode(page, CODE)
}

/** The current clipboard contents, or null when it cannot be read. */
function clipboardText(page) {
    return page.evaluate(() => navigator.clipboard.readText())
}

test.describe('toolbar', () => {
    test('Save downloads the editor contents as a .php file', async ({ page }) => {
        await openWithClipboard(page)

        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#save-button').click()])

        expect(download.suggestedFilename()).toMatch(/^playground-\d{8}-\d{4}\.php$/)
        // Read it back rather than trusting the name.
        const stream = await download.createReadStream()
        const chunks = []
        for await (const chunk of stream) chunks.push(chunk)
        expect(Buffer.concat(chunks).toString()).toBe(CODE)
    })

    test('Copy puts the editor contents on the clipboard', async ({ page }) => {
        await openWithClipboard(page)
        await page.evaluate(() => navigator.clipboard.writeText('untouched'))

        await page.locator('#copy-button').click()
        await expect.poll(() => clipboardText(page)).toBe(CODE)
    })

    test('Load replaces the editor contents with the chosen file', async ({ page }) => {
        await openWithClipboard(page)

        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.locator('#load-file-button').click()
        ])
        await chooser.setFiles({
            name: 'loaded.php',
            mimeType: 'text/plain',
            buffer: Buffer.from('<?php echo "from a file";')
        })

        await expect
            .poll(() => page.evaluate(() => window.phpPlayground.getContent()))
            .toBe('<?php echo "from a file";')
    })

    test('Ctrl+S saves instead of opening the browser save dialog', async ({ page }) => {
        await openWithClipboard(page)

        // No dialog would surface as a download here; the shortcut has to produce one.
        const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')])
        expect(download.suggestedFilename()).toMatch(/^playground-\d{8}-\d{4}\.php$/)
    })

    test('Ctrl+C copies the editor contents when nothing is selected', async ({ page }) => {
        await openWithClipboard(page)
        await page.evaluate(() => {
            getSelection().removeAllRanges()
            navigator.clipboard.writeText('untouched')
        })

        await page.keyboard.press('Control+c')
        await expect.poll(() => clipboardText(page)).toBe(CODE)
    })

    test('Ctrl+C leaves a text selection copy alone', async ({ page }) => {
        await openWithClipboard(page)

        // With a selection, Ctrl+C has to stay the browser's copy: hijacking it
        // would make selecting and copying anything on the page impossible.
        await page.evaluate(() => {
            const note = document.createElement('p')
            note.id = 'copyable'
            note.textContent = 'some page text'
            document.querySelector('#main-container').prepend(note)
            const range = document.createRange()
            range.selectNodeContents(note)
            const selection = getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
        })

        await page.keyboard.press('Control+c')
        await expect.poll(() => clipboardText(page)).toBe('some page text')
    })

    test('the buttons are reachable by keyboard', async ({ page }) => {
        await openWithClipboard(page)

        for (const id of ['#load-file-button', '#save-button', '#copy-button']) {
            await expect(page.locator(id)).toBeVisible()
            await page.locator(id).focus()
            await expect(page.locator(id)).toBeFocused()
        }
    })
})
