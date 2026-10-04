/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Shared helpers for the e2e specs.
 *
 * The playground has no test-visible hooks beyond window.phpPlayground (the
 * single-editor page) and the panel ids that multi-run.js generates, so most of
 * what follows is "wait until the page has finished booting" -- which is a real
 * wait, not a sleep: the version list, the example list and version.json all
 * arrive over fetch after DOMContentLoaded, and the first run then downloads and
 * compiles the WASM module.
 */

import { expect } from 'playwright/test'

/**
 * Open the single-editor page and wait until it is usable: the debug surface
 * exists and the version dropdown has been populated from php-versions.json.
 *
 * Also collects console errors and failed requests so a spec can assert that a
 * boot was clean (see page.__pageErrors).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [path]
 */
export async function openPlayground(page, path = '/index.html') {
    page.__pageErrors = []
    page.on('console', message => {
        if (message.type() === 'error') page.__pageErrors.push(message.text())
    })
    page.on('pageerror', error => page.__pageErrors.push(error.message))
    page.on('requestfailed', request => {
        page.__pageErrors.push(`request failed: ${request.url()} (${request.failure()?.errorText})`)
    })

    await page.goto(path)

    // window.phpPlayground is assigned at the end of the DOMContentLoaded handler,
    // after loadPhpVersions()/loadExamplesList()/loadVersion() have resolved, so
    // its presence means the boot sequence finished.
    await page.waitForFunction(() => Boolean(window.phpPlayground))
    await expect(page.locator('#php-version-switcher option')).not.toHaveCount(1)
    return page
}

/** The values of the PHP version dropdown, placeholder excluded. */
export function versionOptions(page) {
    return page.$$eval('#php-version-switcher option', options => options.map(option => option.value).filter(Boolean))
}

/** The version the dropdown is currently on, which is also the default (highest). */
export async function selectedVersion(page) {
    return page.$eval('#php-version-switcher', dropdown => dropdown.value)
}

/**
 * Put code into the editor through the debug surface, bypassing both backends.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} code
 */
export async function setEditorCode(page, code) {
    await page.evaluate(value => window.phpPlayground.setContent(value), code)
    expect(await page.evaluate(() => window.phpPlayground.getContent())).toBe(code)
}

/** What the editor currently holds, read back through the same surface. */
export function editorCode(page) {
    return page.evaluate(() => window.phpPlayground.getContent())
}

/**
 * Switch the editor backend and wait for the swap to be complete.
 *
 * switchEditor() is async and only assigns the new instance after the old one
 * has been torn down -- and the new DOM node is mounted before that. Waiting for
 * `.monaco-editor`/`.CodeMirror` to appear therefore proves nothing about
 * getContent() still working: in the gap, the old <textarea> is gone and the new
 * <div> has no `.value`, so a read returns undefined. Poll for a backend that
 * can actually answer.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'monaco'|'codemirror'} type
 */
export async function switchEditor(page, type) {
    await page.locator('#editor-switcher').selectOption(type)
    await expect
        .poll(() =>
            page.evaluate(() => {
                const editor = window.phpPlayground?.editor
                return (
                    Boolean(editor) &&
                    editor.currentEditor === document.getElementById('editor-switcher').value &&
                    typeof editor.getContent() === 'string'
                )
            })
        )
        .toBe(true)
}

/**
 * Click Run and wait for the output panel to stop saying "Ready!".
 *
 * Waiting on the panel rather than on a timer is what makes this reliable: the
 * module download is variable, and a fixed sleep would be a coin flip on CI.
 *
 * Note for the test author: PHP's output layer only hands a chunk to the SAPI
 * when it contains a newline, so a program whose last write has no trailing
 * "\n" leaves that tail buffered -- it surfaces in the *next* run. Every snippet
 * in the suite therefore ends its output with a newline; scripts that do not are
 * a bug in the bridge, not something to assert on.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function runCode(page) {
    const output = page.locator('#standard-output')
    await output.waitFor()
    await page.locator('#run-button').click()
    await expect(output).not.toHaveText('Ready!')
}

/** Text of the standard output panel. */
export function outputText(page) {
    return page.locator('#standard-output').textContent()
}

/** Text of the standard error panel. */
export function errorText(page) {
    return page.locator('#standard-error-output').textContent()
}

/**
 * Open multi.html and wait until the first version panel exists.
 *
 * multi-run.js builds one panel at the end of its own DOMContentLoaded handler
 * and has no window.* debug surface, so the generated panel ids are the only
 * handle on it: panel N owns #version-select-N, #run-button-N, #remove-button-N,
 * #output-N, #error-N, #php-version-N and #perf-data-N.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function openMultiRun(page) {
    page.__pageErrors = []
    page.on('console', message => {
        if (message.type() === 'error') page.__pageErrors.push(message.text())
    })
    page.on('pageerror', error => page.__pageErrors.push(error.message))

    await page.goto('/multi.html')
    await expect(page.locator('#version-select-1')).toBeAttached()
    // multi-run.js initialises the editor asynchronously and nobody awaits it, so
    // the panel can exist while #editor is still the <textarea> from the markup.
    await waitForMultiEditor(page)
    return page
}

/** The panel ids currently mounted, in document order. */
export function panelIds(page) {
    return page.$$eval('#version-panels-container select[id^="version-select-"]', nodes =>
        nodes.map(node => node.id.replace('version-select-', ''))
    )
}

/**
 * Wait for a panel to leave its "Ready!" placeholder.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} id
 */
export function waitForPanelRun(page, id) {
    return expect(page.locator(`#output-${id}`)).not.toHaveText('Ready!')
}

/**
 * Wait until multi.html's shared editor has mounted a backend.
 *
 * The editor replaces the markup <textarea> with its own node, so a write that
 * lands first goes into a textarea that is then thrown away.
 *
 * @param {import('@playwright/test').Page} page
 */
export function waitForMultiEditor(page) {
    return page.waitForFunction(() => Boolean(window.monaco?.editor.getModels()[0]))
}

/**
 * Put code into multi.html's shared editor, which has no debug surface: the
 * backend's own global is the only handle (Monaco's models, or CodeMirror hung
 * off its host textarea), so both are handled.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} code
 */
export async function setMultiEditorCode(page, code) {
    await waitForMultiEditor(page)
    await page.evaluate(value => {
        const model = window.monaco?.editor.getModels()[0]
        if (model) model.setValue(value)
        else if (document.getElementById('editor').CodeMirror)
            document.getElementById('editor').CodeMirror.setValue(value)
        else document.getElementById('editor').value = value
    }, code)
    expect(await multiEditorCode(page)).toBe(code)
}

/** What multi.html's shared editor currently holds. */
export function multiEditorCode(page) {
    return page.evaluate(() => {
        const model = window.monaco?.editor.getModels()[0]
        if (model) return model.getValue()
        const element = document.getElementById('editor')
        return element?.CodeMirror ? element.CodeMirror.getValue() : (element?.value ?? '')
    })
}
