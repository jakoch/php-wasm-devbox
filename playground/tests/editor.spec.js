/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Editor: the Monaco <-> CodeMirror switch must not lose the user's code.
 *
 * The switch rebuilds the editor from scratch, so content is the only thing
 * carried across; the DOM-node assertions prove it really happened.
 */

import { expect, test } from 'playwright/test'

import { editorCode, openPlayground, setEditorCode, switchEditor } from './helpers.js'

const CODE = '<?php\n// survives the switch\necho strtoupper("switched");\n'

test.describe('editor', () => {
    test('starts on Monaco', async ({ page }) => {
        await openPlayground(page)

        await expect(page.locator('#editor-switcher')).toHaveValue('monaco')
        // Monaco mounts a <div>; CodeMirror replaces it with a <textarea>.
        await expect(page.locator('#editor')).toHaveJSProperty('tagName', 'DIV')
        await expect(page.locator('#editor .monaco-editor')).toBeVisible()
    })

    test('switching to CodeMirror preserves the content', async ({ page }) => {
        await openPlayground(page)
        await setEditorCode(page, CODE)

        await switchEditor(page, 'codemirror')

        // CodeMirror wraps its host textarea, so the mounted element is a TEXTAREA
        // again and .CodeMirror is its editor chrome.
        await expect(page.locator('#editor')).toHaveJSProperty('tagName', 'TEXTAREA')
        await expect(page.locator('.CodeMirror')).toBeVisible()
        expect(await editorCode(page)).toBe(CODE)

        // The switch is not a no-op that merely reports the new value.
        await expect(page.locator('.monaco-editor')).toHaveCount(0)
    })

    test('switching back to Monaco preserves the content', async ({ page }) => {
        await openPlayground(page)
        await setEditorCode(page, CODE)

        await switchEditor(page, 'codemirror')
        await expect(page.locator('.CodeMirror')).toBeVisible()

        await switchEditor(page, 'monaco')
        await expect(page.locator('#editor')).toHaveJSProperty('tagName', 'DIV')
        await expect(page.locator('.CodeMirror')).toHaveCount(0)

        expect(await editorCode(page)).toBe(CODE)
    })

    test('an edit made in CodeMirror survives a switch to Monaco', async ({ page }) => {
        await openPlayground(page)

        await switchEditor(page, 'codemirror')
        await expect(page.locator('.CodeMirror')).toBeVisible()

        // Type into CodeMirror rather than through the debug surface: the point is
        // that the live instance's content is what gets carried over.
        await page.locator('.CodeMirror').click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('<?php echo "typed in codemirror";')
        await expect.poll(() => editorCode(page)).toContain('typed in codemirror')

        await switchEditor(page, 'monaco')
        await expect(page.locator('.monaco-editor')).toBeVisible()
        expect(await editorCode(page)).toContain('typed in codemirror')
    })

    test('a switch is round-trip safe: content survives repeated toggling', async ({ page }) => {
        await openPlayground(page)
        await setEditorCode(page, CODE)

        for (const type of ['codemirror', 'monaco', 'codemirror', 'monaco']) {
            await switchEditor(page, type)
            expect(await editorCode(page), `after switching to ${type}`).toBe(CODE)
        }
    })

    test('font size controls apply to the live editor', async ({ page }) => {
        await openPlayground(page)

        await expect(page.locator('#font-size-value')).toHaveText('14px')
        await page.locator('#font-increase').click()
        await expect(page.locator('#font-size-value')).toHaveText('15px')
        await page.locator('#font-decrease').click()
        await expect(page.locator('#font-size-value')).toHaveText('14px')

        // Ctrl+- / Ctrl++ are the advertised shortcuts.
        await page.keyboard.press('ControlOrMeta+Equal')
        await expect(page.locator('#font-size-value')).toHaveText('15px')
        await page.keyboard.press('ControlOrMeta+Minus')
        await expect(page.locator('#font-size-value')).toHaveText('14px')

        // The font size itself must reach the editor, not just the label.
        await page.locator('#font-increase').click()
        const fontSize = await page.evaluate(() => window.phpPlayground.editor.getFontSize())
        expect(fontSize).toBe(15)
    })

    test('the documentation panel lists the functions in the editor', async ({ page }) => {
        await openPlayground(page)

        await setEditorCode(page, '<?php echo strtoupper("x") . PHP_EOL; if (true) { echo 1; }')
        // The footer is built on content change; give it a tick to render.
        await expect(page.locator('#docs-panel-footer')).toContainText('strtoupper')
        // Language constructs must not be listed as functions (WP-11.1).
        await expect(page.locator('#docs-panel-footer')).not.toContainText('>if<')
    })
})
