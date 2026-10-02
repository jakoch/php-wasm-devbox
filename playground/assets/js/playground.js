/**
 * Playground Overview
 * --------------------
 * The class PHP is used to manage the PHP WASM module and its interactions.
 * The class CodeEditor is used to manage the editor instance and its interactions.
 * The class uiElements object is used to manage UI element data using getter and setter properties.
 * The event listeners are added to the UI elements to handle the interactions.
 *
 * The following interactions are handled:
 *  - run, save, reset buttons
 *  - editor switcher, php version switcher
 *  - output mode toggle
 */

import { Timer } from './timer.js';

/*
 * Where the opcode dump stages the snippet. VLD names the dump after the file it
 * compiled, so a fixed path keeps the output predictable. Kept out of /tmp so it
 * cannot collide with VLD's own save_dir, should that ever be turned on.
 */
const VLD_DIR = '/vld';
const SNIPPET_PATH = `${VLD_DIR}/snip.php`;

/**
 * The class PHP is used to manage the PHP WASM module and its interactions.
 *
 * @example
 * const php = new PHP();
 * const result = await php.runPHP(code, php_version);
 * console.log(result.output);
 * console.log(result.output_stderr);
 * console.log(result.version);
 * console.log(result.executionTime);
 */
class PHP {
    // Static cache for WASM modules to avoid reloading
    static #wasmModuleCache = {};

    #buffer_stdout = [];
    #buffer_stderr = [];
    #runPhp = null;
    #version = '';
    // The resolved WASM module namespace. Held for ccall and for FS, which the
    // opcode dump uses to stage a snippet before compiling it.
    #module = null;
    // When set, receives the corresponding stream instead of #buffer_stdout /
    // #buffer_stderr. Emscripten captures the print/printErr callbacks passed to
    // createPhpModule() and never looks them up again, so reassigning
    // module.print later has no effect; the capture has to be a mutable
    // destination behind the one callback installed at construction.
    #stdoutSink = null;
    #stderrSink = null;

    // Static method to get the base path for WASM modules
    // This needs to handle gh-pages and local development paths correctly
    static getBasePath = () => {
        const match = location.pathname.match(/^\/(php-wasm-devbox)(\/|$)/);
        return match ? `/${match[1]}` : '';
    };

    // Base path for WASM modules, set once during class initialization
    #basePath = PHP.getBasePath();

    async #loadWasmBinary(php_version) {
        if (!PHP.#wasmModuleCache[php_version]) {
            const wasmUrl = `${this.#basePath}/assets/wasm/php-${php_version}-web.wasm`;
            PHP.#wasmModuleCache[php_version] = fetch(wasmUrl)
                .then(res => {
                    if (!res.ok) throw new Error(`Failed to fetch WASM: ${res.statusText}`);
                    return res.arrayBuffer();
                });
        }
        return PHP.#wasmModuleCache[php_version];
    }

    async #loadWasmModule(php_version) {
        // if the PHP module is already loaded, return the runPHP function
        if (this.#runPhp && this.#version === php_version) {
            return this.#runPhp;
        }

        // load the WASM module dynamically based on the PHP version
        const moduleUrl = `${this.#basePath}/assets/wasm/php-${php_version}-web.mjs`;
        const createPhpModule = (await import(moduleUrl)).default;

        // load the WASM binary and cache it
        const wasmBinary = await this.#loadWasmBinary(php_version);

        // set options for the PHP WASM module
        // Emscripten calls print/printErr once per line with the newline already
        // stripped, so joining with '\n' reassembles the original text. Only a
        // genuinely absent chunk should be skipped: an empty string is a blank
        // line, which is real output the user asked for.
        const phpModuleOptions = {
            wasmBinary,
            print: (data) => {
                if (data === undefined || data === null) return;
                // getOpcodes() borrows this stream; see #stdoutSink.
                if (this.#stdoutSink) {
                    this.#stdoutSink(data);
                    return;
                }
                if (this.#buffer_stdout.length) this.#buffer_stdout.push('\n');
                this.#buffer_stdout.push(data);
            },
            printErr: (data) => {
                if (data === undefined || data === null) return;
                // getOpcodes() borrows this stream; see #stderrSink.
                if (this.#stderrSink) {
                    this.#stderrSink(data);
                    return;
                }
                if (this.#buffer_stderr.length) this.#buffer_stderr.push('\n');
                this.#buffer_stderr.push(data);
            }
        };

        // initialize the PHP WASM module
        // Keep the whole namespace, not just ccall: the opcode dump needs FS to
        // stage the snippet in the in-memory filesystem before phpw() compiles it.
        this.#module = await createPhpModule(phpModuleOptions);
        const { ccall } = this.#module;

        // get the PHP version
        this.#version = ccall("phpw_exec", "string", ["string"], ["phpversion();"]) || "unknown";

        // Create the runPhp function that will execute the PHP code
        this.#runPhp = (code) => ccall("phpw_run", null, ["string"], [`?>${code}`]);

        return this.#runPhp;
    }

    async runPHP(code, php_version) {
        if (!php_version) {
            throw new Error("Invalid PHP version!");
        }

        this.#buffer_stdout = [];
        this.#buffer_stderr = [];

        try {
            const runPhp = await this.#loadWasmModule(php_version);
            const startTime = performance.now();

            runPhp(code); // directly run

            const endTime = performance.now();
            const elapsedTime = endTime - startTime;
            return {
                output: this.stdout,
                output_error: this.stderr,
                version: this.version,
                executionTime: Timer.formatTime(elapsedTime)
            };
        } catch (error) {
            throw new Error(`PHP execution failed: ${error.message}`);
        }
    }

    /**
     * Make sure the module for a PHP version is instantiated.
     *
     * Loading a version can mean a several-megabyte download, so callers that
     * only need the module's presence should await this instead of triggering a
     * run. Returns the module namespace.
     *
     * @param {string} php_version  e.g. "8.5.11"
     * @returns {Promise<object>}   The module namespace
     */
    async loadModule(php_version) {
        await this.#loadWasmModule(php_version);

        return this.#module;
    }

    /**
     * Compile PHP code and return VLD's opcode dump, without executing it.
     *
     * VLD dumps over both C streams, which is the part that is easy to get wrong:
     * the opcode table and its analysis commentary go to stderr via vld_printf(),
     * but branchinfo.c writes the branch/path summary with bare printf(), i.e.
     * stdout. Since the snippet never executes, nothing else can appear on either
     * stream, so both are borrowed for the duration and appended to one buffer in
     * arrival order. Borrow them both rather than setting vld.dump_paths=0: that
     * would silence the stdout half but also cost the E/I/O branch markers and,
     * with them, the reachability information in the #* column.
     *
     * Two INI directives make the capture safe: vld.active=1 installs the compiler
     * hooks on request init, and vld.execute=0 replaces the executor with a no-op.
     * The snippet is staged as a real file rather than eval'd, so the line numbers
     * in the dump match the editor exactly.
     *
     * @param {string} code       PHP source, opening tag included
     * @param {number} verbosity  VLD verbosity, 0-3. 0 is the opcode listing alone;
     *                            1 adds VLD's branch-analysis commentary, 2 and 3
     *                            add its internal trace.
     * @returns {string}          The opcode dump
     * @throws {Error}            If VLD is unavailable, or the code does not compile
     */
    getOpcodes(code, verbosity = 0) {
        const module = this.#module;
        if (!module || typeof module.ccall !== 'function') {
            throw new Error('The PHP module is not loaded yet.');
        }

        const { ccall, FS } = module;

        const ok = ccall('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [1, 0, verbosity, 1]);
        if (ok !== 0) {
            // Almost always a module built without VLD. Say so rather than
            // returning an empty dump that looks like a silent failure.
            throw new Error(
                ccall('phpw_last_error', 'string', [], []) || 'Could not enable opcode dumping.'
            );
        }

        // Emscripten hands print/printErr one line at a time, newline already
        // stripped, so a separator on every call is what reassembles the original
        // text. Do NOT skip empty strings: VLD separates op_array blocks with
        // blank lines, and dropping them mangles the dump.
        const lines = [];
        const collect = (text) => lines.push(`${text}\n`);
        this.#stdoutSink = collect;
        this.#stderrSink = collect;

        let status = 0;
        try {
            try {
                FS.mkdir(VLD_DIR);
            } catch (e) {
                // EEXIST: the directory outlives individual runs by design.
            }
            FS.writeFile(SNIPPET_PATH, code);
            status = ccall('phpw', null, ['string'], [SNIPPET_PATH]);
        } finally {
            this.#stdoutSink = null;
            this.#stderrSink = null;
            // Leave VLD inert so ordinary runs stay unaffected.
            ccall('phpw_vld_config', 'number', ['number', 'number', 'number', 'number'], [0, 1, 1, 1]);
            try {
                FS.unlink(SNIPPET_PATH);
            } catch (e) {
                // Already gone; nothing to clean up.
            }
        }

        if (status !== 0) {
            // A parse error reached stderr during the compile and is now inside
            // the captured text. Surface it as an error instead of as opcodes.
            throw new Error(ccall('phpw_last_error', 'string', [], []) || 'The code could not be compiled.');
        }

        return lines.join('');
    }

    get stdout() {
        return this.#buffer_stdout.join('');
    }

    get stderr() {
        return this.#buffer_stderr.join('');
    }

    get version() {
        return this.#version;
    }

    unload() {
        this.#buffer_stdout = [];
        this.#buffer_stderr = [];
        this.#runPhp = null;
        this.#version = '';
    }
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/*
 * Column offsets of a VLD listing row, measured against the dump that
 * vld_dump_op() in srm_oparray.c produces (VLD 0.19.1) rather than counted by
 * hand. Each row is emitted as:
 *     "%5d "  source line        cols  0-5
 *     "%5d"   opcode number      cols  6-10
 *     "%c"    notdead  ' '|'*'   col   11
 *     " %c"   entry    ' '|'E'   col   13
 *     " %c"   start    ' '|'>'   col   15
 *     " %c"   end      ' '|'>'   col   17
 *     " %-32s ..."  opcode name from col 19
 * VLD's own ruler header is off by one against this (it prints "#" at col 10),
 * so the data columns are what the highlighting uses.
 */
const OPC_MARKER_NOTDEAD = 11;
const OPC_MARKER_ENTRY = 13;
const OPC_MARKER_START = 15;
const OPC_MARKER_END = 17;
const OPC_NAME_START = 19;

/**
 * Render one line of a VLD dump to HTML.
 *
 * The four marker columns are matched by position, not by pattern: `E` and `>`
 * also occur inside operand text (`->2`, `'a>b'`) and a pattern would highlight
 * the wrong things. The row shape is verified first, so a line that does not fit
 * — a `branch:` summary, a future format change — falls through to generic
 * highlighting instead of being sliced at arbitrary offsets.
 *
 * Note that VLD URL-encodes string operands (`php_url_encode()` in
 * vld_dump_zval_string), so operand text cannot contain markup even before
 * escaping. Everything is escaped regardless; that is defence in depth, not the
 * primary defence.
 *
 * @param {string} line  A single dump line, unescaped
 * @returns {string}     HTML, safe to assign to innerHTML
 */
function renderOpcodeLine(line) {
    const at = (index) => line[index] ?? ' ';
    const isListingRow = line.length > OPC_NAME_START + 1
        && /^\s*\d/.test(line)
        && /^\s*$/.test(line.slice(6, 10))
        && /^[* ]$/.test(at(OPC_MARKER_NOTDEAD))
        && /^[E ]$/.test(at(OPC_MARKER_ENTRY))
        && /^[> ]$/.test(at(OPC_MARKER_START))
        && /^[> ]$/.test(at(OPC_MARKER_END));

    if (!isListingRow) {
        return highlightOpcodeOperands(line);
    }

    const head = line.slice(0, OPC_MARKER_NOTDEAD);
    const markers = line
        .slice(OPC_MARKER_NOTDEAD, OPC_MARKER_END + 1)
        // Escape the marker too: '>' is legal in HTML text but inconsistent to
        // leave raw next to the escaped copies elsewhere on the line.
        .replace(/([E*>])/g, (marker) => `<span class="opc-mark">${escapeHtml(marker)}</span>`);

    const afterMarkers = line.slice(OPC_MARKER_END + 1);
    const padding = afterMarkers.slice(0, OPC_NAME_START - (OPC_MARKER_END + 1));
    const listing = afterMarkers.slice(OPC_NAME_START - (OPC_MARKER_END + 1));

    return escapeHtml(head) + markers + escapeHtml(padding) + highlightOpcodeOperands(listing);
}

/**
 * Colour the opcode name, jump targets, operand slots and strings.
 *
 * Runs over already-column-verified text; the opcode name is the first all-caps
 * identifier at or after column 13, and everything else is matched by shape.
 */
function highlightOpcodeOperands(text) {
    const pattern = /(->\d+)|([!$~]\d+)|('(?:[^'\\]|\\.)*')|(\b[A-Z][A-Z0-9_]{1,}\b)/g;
    const classes = ['opc-jump', 'opc-slot', 'opc-string', 'opc-name'];
    let html = '';
    let last = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        html += escapeHtml(text.slice(last, match.index));
        // Exactly one of the four groups participates in a given match, so the
        // first defined group index identifies which.
        const cls = classes[match.slice(1).findIndex((group) => group !== undefined)];
        html += `<span class="${cls}">${escapeHtml(match[0])}</span>`;
        last = match.index + match[0].length;
    }

    html += escapeHtml(text.slice(last));

    return html;
}

/**
 * Turn a whole dump into highlighted, size-capped HTML.
 *
 * A large dump is a real possibility (a few thousand opcodes is a few hundred KB
 * of markup), so the line count is capped and the truncation is reported rather
 * than silently applied.
 *
 * @param {string} dump        Raw dump text from PHP.getOpcodes()
 * @param {number} maxLines    Cap on rendered lines
 * @returns {{ html: string, shown: number, total: number, truncated: boolean }}
 */
function renderOpcodeDump(dump, maxLines = 4000) {
    const allLines = String(dump).split('\n');
    // A trailing newline yields one empty tail element; it is not a line.
    if (allLines.length && allLines[allLines.length - 1] === '') allLines.pop();

    const shown = allLines.slice(0, maxLines);

    return {
        html: shown
            .map((line) => {
                if (/^-{20,}$/.test(line)) return `<span class="opc-rule">${escapeHtml(line)}</span>`;
                if (/^(filename|function name|number of ops|compiled vars):/.test(line)) {
                    return `<span class="opc-meta">${escapeHtml(line)}</span>`;
                }
                return renderOpcodeLine(line);
            })
            .join('\n'),
        shown: shown.length,
        total: allLines.length,
        truncated: allLines.length > shown.length,
    };
}

/**
 * Minimal ARIA tab controller for the result panels.
 *
 * Bootstrap's collapse and tab JS is not loaded by this page (only its CSS is),
 * so data-bs-toggle cannot be relied on. Keyboard support follows
 * the WAI-ARIA tabs pattern: arrows move and activate, Home/End jump.
 */
function setupResultTabs(root = document) {
    const tabs = Array.from(root.querySelectorAll('[data-result-tab]'));

    if (tabs.length === 0) return null;

    const panels = new Map();
    const toolbars = Array.from(root.querySelectorAll('[data-result-tab-toolbar]'));

    function show(name, { focus = false } = {}) {
        for (const tab of tabs) {
            const active = tab.dataset.resultTab === name;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            // Roving tabindex: only the active tab is in the tab order.
            tab.tabIndex = active ? 0 : -1;
            if (active && focus) tab.focus();
        }

        // panels is a Map: Object.values() on one returns [], which would leave every
        // panel visible and silently stack all three on top of each other.
        for (const panel of panels.values()) panel.hidden = true;

        const panel = panels.get(name);
        if (panel) panel.hidden = false;

        for (const toolbar of toolbars) {
            toolbar.hidden = toolbar.dataset.resultTabToolbar !== name;
        }
    }

    for (const tab of tabs) {
        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        if (panel) panels.set(tab.dataset.resultTab, panel);

        tab.addEventListener('click', (event) => {
            event.preventDefault();
            show(tab.dataset.resultTab);
        });

        tab.addEventListener('keydown', (event) => {
            const current = tabs.indexOf(tab);
            let next = null;

            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                next = (current + 1) % tabs.length;
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                next = (current - 1 + tabs.length) % tabs.length;
            } else if (event.key === 'Home') {
                next = 0;
            } else if (event.key === 'End') {
                next = tabs.length - 1;
            }

            if (next === null) return;
            event.preventDefault();
            show(tabs[next].dataset.resultTab, { focus: true });
        });
    }

    show('output');

    return { show, isActive: (name) => tabs.some((t) => t.dataset.resultTab === name && t.classList.contains('active')) };
}

/**
 * CodeEditor class to manage the editor instance and its interactions.
 *
 * @example
 * // Initialize the editor
 * const editor = new CodeEditor();
 *
 * // Switch to Monaco editor
 * await editor.switchEditor("monaco");
 *
 * // Switch to CodeMirror editor
 * await editor.switchEditor("codemirror");
 *
 * // Cleanup when done
 * await editor.dispose();
 */
class CodeEditor {
    #editorInstance = null;
    #currentEditor = "monaco";
    #statusBar = {
        cursor: document.getElementById("statusbar-cursor"),
        size: document.getElementById("statusbar-size")
    };
    #fontSize = 14;
    #minFontSize = 10;
    #maxFontSize = 32;

    constructor() {
        // Initialize immediately
        this.init();
    }

    async init() {
        await this.switchEditor(this.#currentEditor);
    }

    get editorInstance() {
        return this.#editorInstance;
    }

    get currentEditor() {
        return this.#currentEditor;
    }

    getEditorElement() {
        const editor = document.getElementById("editor");
        if (!editor) {
            console.warn("Editor textarea element not found!");
            return null;
        }
        return editor;
    }

    getContent() {
        const editor = this.getEditorElement();
        if (this.#editorInstance && typeof this.#editorInstance.getValue === "function") {
            return this.#editorInstance.getValue();
        }
        return editor ? editor.value : "";
    }

    setContent(content) {
        if (this.#editorInstance && typeof this.#editorInstance.setValue === "function") {
            this.#editorInstance.setValue(content);
            return;
        }

        const editor = this.getEditorElement();
        if (editor) {
            editor.value = content;
        }
        this.updateStatusBar();
    }

    setStatusBar(line = 1, col = 1, size = 0) {
        if (this.#statusBar.cursor) {
            this.#statusBar.cursor.textContent = `Ln: ${line}, Col: ${col}`;
        }
        if (this.#statusBar.size) {
            this.#statusBar.size.textContent = `Size: ${size} bytes`;
        }
    }

    updateStatusBar() {
        const content = this.getContent();
        let line = 1, col = 1;
        if (this.#editorInstance) {
            if (this.#currentEditor === "monaco" && this.#editorInstance.getPosition) {
                const pos = this.#editorInstance.getPosition();
                line = pos.lineNumber;
                col = pos.column;
            } else if (this.#currentEditor === "codemirror" && this.#editorInstance.getCursor) {
                const pos = this.#editorInstance.getCursor();
                line = pos.line + 1;
                col = pos.ch + 1;
            }
        }
        this.setStatusBar(line, col, content.length);
        this.updateDocsPanel();
    }

    updateDocsPanel() {
        const docsPanelFooter = document.getElementById('docs-panel-footer');
        if (!docsPanelFooter) return;
        const content = this.getContent();
        // Simple regex to match PHP function calls (not perfect, but works for most cases)
        const functionRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
        const phpKeywords = new Set([
            'if','else','elseif','for','foreach','while','do','switch','case','break','continue','return','function','echo','print','include','require','require_once','include_once','namespace','class','interface','trait','extends','implements','public','protected','private','static','abstract','final','const','var','new','try','catch','finally','throw','use','global','isset','unset','empty','array','list','callable','clone','declare','default','die','enddeclare','endfor','endforeach','endif','endswitch','endwhile','eval','exit','goto','instanceof','insteadof','yield','match','print_r','var_dump','define','self','parent','static','true','false','null','__construct','__destruct','__call','__callStatic','__get','__set','__isset','__unset','__sleep','__wakeup','__toString','__invoke','__set_state','__clone','__debugInfo'
        ]);
        const foundSet = new Set();
        const foundOrdered = [];
        let match;
        while ((match = functionRegex.exec(content)) !== null) {
            const fn = match[1];
            if (!phpKeywords.has(fn) && !foundSet.has(fn)) {
                foundSet.add(fn);
                foundOrdered.push(fn);
            }
        }
        if (foundOrdered.length === 0) {
            docsPanelFooter.innerHTML = '<span class="text-muted">No PHP functions detected.</span>';
            return;
        }
        docsPanelFooter.innerHTML = foundOrdered.map(fn =>
            `<a href="https://www.php.net/manual/en/function.${fn.toLowerCase()}.php" target="_blank" rel="noopener" class="text-info text-decoration-underline me-3">${fn}()</a>`
        ).join(' ');
    }

    async destroyCurrentEditor() {
        if (this.#editorInstance) {
            if (this.#currentEditor === "monaco") {
                this.#editorInstance.dispose();
            } else if (this.#currentEditor === "codemirror") {
                this.#editorInstance.toTextArea();
            }
            this.#editorInstance = null;
        }
    }

    async switchEditor(editorType) {
        console.log("Switching editor to:", editorType);
        try {
            const content = this.getContent();

            await this.destroyCurrentEditor();

            if (editorType === "monaco") {
                this.#editorInstance = await this.initMonacoEditor();
            } else {
                this.#editorInstance = this.initCodeMirror();
            }

            this.setContent(content);
            this.#currentEditor = editorType;
        } catch (error) {
            console.error("Failed to switch editor:", error);
            throw error;
        }

        if (this.#editorInstance) {
            if (editorType === "monaco") {
                this.#editorInstance.onDidChangeCursorPosition(() => this.updateStatusBar());
                this.#editorInstance.onDidChangeModelContent(() => this.updateStatusBar());
            } else if (editorType === "codemirror") {
                this.#editorInstance.on("cursorActivity", () => this.updateStatusBar());
                this.#editorInstance.on("change", () => this.updateStatusBar());
            }
        }
        this.updateStatusBar();
    }

    initCodeMirror() {
        const editor = this.getEditorElement();
        if (!editor) throw new Error("No editor element found");

        if (editor.classList.contains("CodeMirror")) {
            return editor.CodeMirror;
        }

        const content = this.getContent();

        // insert a textarea element for CodeMirror
        const newEditor = document.createElement("textarea");
        newEditor.id = "editor";
        newEditor.textContent = content;
        //newEditor.className = "resizable-content";
        newEditor.style.height = "300px";
        editor.replaceWith(newEditor);

        return CodeMirror.fromTextArea(newEditor, {
            mode: "text/x-php",
            matchBrackets: true,
            lineNumbers: true,
            firstLineNumber: 1,
            indentUnit: 4,
            indentWithTabs: true,
            autoRefresh: true,
            styleActiveLine: true,
            theme: 'monokai',
            gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"],
            extraKeys: { Tab: "indentMore" }
        });
    }

    async initMonacoEditor() {
        return new Promise((resolve, reject) => {
            require.config({
                paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs" }
            });

            require(["vs/editor/editor.main"], () => {
                try {
                    const editor = this.getEditorElement();
                    if (!editor) throw new Error("No editor element found");

                    const content = this.getContent();

                    const newEditor = document.createElement("div");
                    newEditor.id = "editor";
                    // preserve the current editor element height so Monaco can compute
                    // its layout correctly on first render
                    try {
                        const rect = editor.getBoundingClientRect();
                        const height = (rect && rect.height) ? Math.round(rect.height) : editor.offsetHeight || 300;
                        newEditor.style.height = height + 'px';
                    } catch (e) {
                        newEditor.style.height = "300px";
                    }
                    editor.replaceWith(newEditor);

                    const monacoInstance = monaco.editor.create(newEditor, {
                        value: content,
                        language: "php",
                        theme: "vs-dark",
                        automaticLayout: true,
                        autoClosingQuotes: 'always',
                        minimap: { enabled: false },
                        wordBasedSuggestions: true,
                        showFoldingControls: "always",
                        smoothScrolling: true,
                        links: true,
                        lineNumbers: "on"
                    });

                    // Delay layout/update to allow browser to paint and compute sizes
                    setTimeout(() => {
                        try {
                            monacoInstance.updateOptions({ lineNumbers: "on" });
                            monacoInstance.layout();
                        } catch (e) {}
                        resolve(monacoInstance);
                    }, 50);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    async dispose() {
        await this.destroyCurrentEditor();
    }

    setFontSize(size) {
        this.#fontSize = Math.max(this.#minFontSize, Math.min(this.#maxFontSize, size));
        if (this.#editorInstance) {
            if (this.#currentEditor === "monaco" && this.#editorInstance.updateOptions) {
                this.#editorInstance.updateOptions({ fontSize: this.#fontSize });
            } else if (this.#currentEditor === "codemirror" && this.#editorInstance.getWrapperElement) {
                this.#editorInstance.getWrapperElement().style.fontSize = this.#fontSize + "px";
                this.#editorInstance.refresh && this.#editorInstance.refresh();
            }
        }
        this.updateFontSizeDisplay();
    }

    getFontSize() {
        return this.#fontSize;
    }

    updateFontSizeDisplay() {
        const fontSizeValue = document.getElementById("font-size-value");
        if (fontSizeValue) fontSizeValue.textContent = this.#fontSize + "px";
    }
}

// Set the auto-run interval (ms)
let AUTO_RUN_INTERVAL_MS = 2000;

// Save content to a file
function saveToFile(content, filename) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// uiElements object to manage UI element data using getter and setter properties
const uiElements = {
    get phpVersionDropdown() {
        const phpVersionDropdown = document.getElementById("php-version-switcher");
        if (!phpVersionDropdown) {
            throw new Error("PHP version selector not found!");
        }
        return phpVersionDropdown.value;
    },
    get output() {
        const outputElement = document.getElementById("standard-output");
        if (outputElement) {
            return outputElement.textContent;
        }
        return "";
    },
    set output(value) {
        const outputElement = document.getElementById("standard-output");
        if (outputElement) {
            outputElement.textContent = value;
        }
    },
    set outputHtml(value) {
        const outputElement = document.getElementById("standard-output");
        if (outputElement) {
            outputElement.innerHTML = value;
        }
    },
    set output_error(value) {
        const outputElement = document.getElementById("standard-error-output");
        if (outputElement) {
            outputElement.textContent = value || "No Errors!";
        }
    },
    get isOutputModeHtml() {
        const outputModeCheckbox = document.getElementById("output-mode-switcher");
        if(outputModeCheckbox?.checked) {
            return true;
        }
        return false;
    },
    set outputModeHtml(value) {
        const outputModeCheckbox = document.getElementById("output-mode-switcher");
        if(outputModeCheckbox) {
            outputModeCheckbox.checked = value;
        }
    },
    set phpVersionDisplay(value) {
        const phpVersionElement = document.getElementById("php-version");
        if (phpVersionElement) {
            phpVersionElement.textContent = value;
        }
    },
    set perfDataDisplay(value) {
        const perfDataElement = document.getElementById("perf-data");
        if (perfDataElement) {
            perfDataElement.textContent = value;
        }
    }
};

function compareVersions(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aNum = aParts[i] || 0;
    const bNum = bParts[i] || 0;
    if (aNum !== bNum) return bNum - aNum; // descending
  }
  return 0;
}

// Fetch the PHP versions from the static JSON file
async function loadPhpVersions() {
    const phpVersionDropdown = document.getElementById("php-version-switcher");
    const response = await fetch('assets/wasm/php-versions.json');
    const versions = await response.json();
    phpVersionDropdown.innerHTML = ''; // Clear existing options
    // sort versions by value, highest first
    versions.sort(compareVersions);
    // add select version as first option
    const selectOption = document.createElement('option');
    selectOption.value = '';
    selectOption.textContent = "Select Version";
    selectOption.disabled = true; // make it unselectable
    phpVersionDropdown.appendChild(selectOption);
    // Populate the dropdown with the versions
    for (const version of versions) {
        const option = document.createElement('option');
        option.value = version;
        option.textContent = "PHP " + version; // label the option with "PHP " prefix
        phpVersionDropdown.appendChild(option);
    }
    // Set the default version to the latest one
    if (versions.length > 0) {
        phpVersionDropdown.value = versions[0]; // Set the first version as default
    }
}

// Load the examples list json and populate the dropdown
async function loadExamplesList() {
    let examples = [];
    const resp = await fetch('examples/examples.json');
    examples = await resp.json();
    const phpExampleDropdown = document.getElementById("php-example-switcher");
    phpExampleDropdown.innerHTML = '';
    // add select example as first option
    const selectOption = document.createElement('option');
    selectOption.value = '';
    selectOption.textContent = "Select Example";
    selectOption.disabled = true; // make it unselectable
    phpExampleDropdown.appendChild(selectOption);
    // Populate the dropdown with the examples
    for (const ex of examples) {
        const opt = document.createElement('option');
        opt.value = ex.value;
        opt.textContent = ex.label;
        phpExampleDropdown.appendChild(opt);
    }
}

// load version.json file to display the application version
async function loadVersion() {
    try {
        const response = await fetch('version.json');
        const versionData = await response.json();
        const versionElement = document.getElementById("app-version");
        versionElement.textContent = `PHP-WASM Playground v${versionData.version} #${versionData.git_hash}`;
    } catch (error) {
        console.error("Error loading version data from version.json:", error);
    }
}

// --- Error Highlighting Utilities ---
function parsePhpError(errorOutput) {
    if (!errorOutput) return null;
    // Robust regex: match 'on line N' or 'in ... on line N' or 'on line N,'
    const regex = /on line (\d+)/i;
    const match = regex.exec(errorOutput);
    if (match) {
        const line = parseInt(match[1], 10);
        // Extract message (first line or up to 'in script')
        let message = errorOutput.split('\n')[0];
        // Try to trim after 'in script' for clarity
        const inScriptIdx = message.indexOf(' in script');
        if (inScriptIdx !== -1) message = message.slice(0, inScriptIdx);
        return { line, message };
    }
    // Fallback: highlight first line if error detected but no line number
    if (/parse error|syntax error|fatal error|unexpected/i.test(errorOutput)) {
        let message = errorOutput.split('\n')[0];
        return { line: 1, message };
    }
    return null;
}

function setEditorErrorMarker(editorInstance, editorType, errorInfo) {
    if (!editorInstance) return;
    if (!errorInfo) {
        // Clear markers
        if (editorType === "monaco" && window.monaco) {
            const model = editorInstance.getModel();
            window.monaco.editor.setModelMarkers(model, "php", []);
        } else if (editorType === "codemirror") {
            if (editorInstance._phpErrorMarks) {
                editorInstance._phpErrorMarks.forEach(mark => mark.clear());
            }
            editorInstance._phpErrorMarks = [];
        }
        return;
    }
    const { line, message } = errorInfo;
    if (editorType === "monaco" && window.monaco) {
        const model = editorInstance.getModel();
        window.monaco.editor.setModelMarkers(model, "php", [{
            startLineNumber: line,
            endLineNumber: line,
            startColumn: 1,
            endColumn: 1000,
            message,
            severity: window.monaco.MarkerSeverity.Error
        }]);
    } else if (editorType === "codemirror") {
        if (!editorInstance._phpErrorMarks) editorInstance._phpErrorMarks = [];
        editorInstance._phpErrorMarks.forEach(mark => mark.clear());
        editorInstance._phpErrorMarks = [];
        const doc = editorInstance.getDoc ? editorInstance.getDoc() : editorInstance;
        const lineIdx = line - 1;
        if (doc.getLine(lineIdx) != null) {
            const mark = doc.markText({ line: lineIdx, ch: 0 }, { line: lineIdx, ch: doc.getLine(lineIdx).length }, { className: 'php-error-marker', title: message });
            editorInstance._phpErrorMarks.push(mark);
        }
    }
}

// Setup Playground Interactions
// Guarded so this file can also be imported by a test harness under Node,
// where there is no document to listen on.
if (typeof document !== 'undefined') {
    document.addEventListener("DOMContentLoaded", async () => {
    const php = new PHP();
    const editor = new CodeEditor();

    /* Load initial data dynamically */

    await loadPhpVersions();
    await loadExamplesList();
    await loadVersion();

    /* Navigation */

    // links in navigation
    const playgroundLink = document.getElementById("playground-link");
    const helpLink = document.getElementById("help-link");
    const helpContainer = document.getElementById("help-container");

    // help link toggles the help section
    helpLink.addEventListener("click", (event) => {
        event.preventDefault();
        helpContainer.classList.toggle("d-none");
    });
    // playground link hides help
    playgroundLink.addEventListener("click", (event) => {
        event.preventDefault();
        helpContainer.classList.add("d-none");
    });

    /* Result tabs */

    const resultTabs = setupResultTabs(document);

    // Surface the Errors tab when a run produced diagnostics. The tab itself is
    // never switched to automatically: auto-run would then yank the view away
    // from whatever the user was reading on every tick.
    const errorBadge = document.getElementById("error-badge");

    function updateErrorBadge(count) {
        if (!errorBadge) return;
        errorBadge.textContent = String(count);
        errorBadge.classList.toggle('d-none', count === 0);
    }

    /* Opcode dump */

    const opcodeOutput = document.getElementById("opcode-output");
    const opcodeStatus = document.getElementById("opcode-status");
    const opcodeVerbosity = document.getElementById("opcode-verbosity");
    const dumpOpcodesButton = document.getElementById("dump-opcodes-button");
    const copyOpcodesButton = document.getElementById("copy-opcodes-button");
    const saveOpcodesButton = document.getElementById("save-opcodes-button");

    // The raw dump, kept so Copy and Save act on what was actually captured
    // rather than on the highlighted markup.
    let opcodeDumpText = '';
    let opcodeDumping = false;

    function setOpcodeStatus(text) {
        if (opcodeStatus) opcodeStatus.textContent = text;
    }

    /**
     * Count diagnostic lines for the Errors tab badge.
     *
     * Only lines that look like PHP diagnostics count; the placeholder text
     * ("No Errors!") and blank lines do not.
     */
    function countDiagnosticLines(text) {
        if (!text) return 0;
        return String(text)
            .split('\n')
            .filter((line) => /^PHP (Warning|Notice|Fatal error|Deprecated|Parse error|Strict Standards)/i.test(line.trim())).length;
    }

    async function dumpOpcodes() {
        if (opcodeDumping) return;

        const version = uiElements.phpVersionDropdown;
        if (!version) {
            setOpcodeStatus('Select a PHP version first.');
            return;
        }

        opcodeDumping = true;
        if (dumpOpcodesButton) dumpOpcodesButton.disabled = true;
        setOpcodeStatus('Compiling…');

        try {
            // Make sure the module for this version is resident; getOpcodes()
            // needs ccall and FS, which only exist once it has been loaded.
            await php.loadModule(version);

            const verbosity = opcodeVerbosity ? parseInt(opcodeVerbosity.value, 10) || 0 : 0;
            const dump = php.getOpcodes(editor.getContent(), verbosity);

            opcodeDumpText = dump;
            const rendered = renderOpcodeDump(dump);

            if (opcodeOutput) opcodeOutput.innerHTML = rendered.html;

            const bytes = new Blob([dump]).size;
            setOpcodeStatus(
                `PHP ${version} · ${rendered.shown} of ${rendered.total} lines · ${bytes} bytes`
                + (rendered.truncated ? ' · truncated' : '')
            );
        } catch (error) {
            opcodeDumpText = '';
            if (opcodeOutput) {
                opcodeOutput.textContent = error.message || String(error);
            }
            setOpcodeStatus('Dump failed.');
        } finally {
            opcodeDumping = false;
            if (dumpOpcodesButton) dumpOpcodesButton.disabled = false;
        }
    }

    if (dumpOpcodesButton) dumpOpcodesButton.addEventListener('click', dumpOpcodes);

    if (copyOpcodesButton) {
        copyOpcodesButton.addEventListener('click', async () => {
            if (!opcodeDumpText) {
                setOpcodeStatus('Nothing to copy yet — click Dump first.');
                return;
            }
            try {
                await navigator.clipboard.writeText(opcodeDumpText);
                setOpcodeStatus('Opcode dump copied to the clipboard.');
            } catch (error) {
                setOpcodeStatus('The clipboard is not available in this browser.');
            }
        });
    }

    if (saveOpcodesButton) {
        saveOpcodesButton.addEventListener('click', () => {
            if (!opcodeDumpText) {
                setOpcodeStatus('Nothing to save yet — click Dump first.');
                return;
            }
            const version = uiElements.phpVersionDropdown || 'unknown';
            saveToFile(opcodeDumpText, `opcodes-${version}.txt`);
            setOpcodeStatus('Opcode dump saved.');
        });
    }

    // Expose a small, documented surface for the console and for the Playwright
    // suite. Deliberately not a bare `window.__php`: naming it makes it a
    // promise to keep, and it is what the tests drive.
    window.phpPlayground = {
        php,
        editor,
        getContent: () => editor.getContent(),
        setContent: (value) => editor.setContent(value),
        getOpcodes: (verbosity) => php.getOpcodes(editor.getContent(), verbosity ?? 0),
        dumpOpcodes,
        showTab: (name) => resultTabs && resultTabs.show(name),
        version: () => uiElements.phpVersionDropdown,
    };

    /* Editor */

    // run button
    const runButton = document.getElementById("run-button");
    // auto run checkbox
    const autoRunCheckbox = document.getElementById("auto-run");
    const autoRunIntervalDisplay = document.getElementById("auto-run-interval");
    const autoRunIntervalSelect = document.getElementById("auto-run-interval-select");
    let runInterval = null;
    let autoRunExecuting = false;
    let editorSwitching = false;

    // Set initial dropdown value to match default interval
    if (autoRunIntervalSelect) {
        autoRunIntervalSelect.value = (AUTO_RUN_INTERVAL_MS / 1000).toString();
        autoRunIntervalSelect.addEventListener("change", (event) => {
            const newVal = parseInt(event.target.value, 10);
            if (!isNaN(newVal)) {
                AUTO_RUN_INTERVAL_MS = newVal * 1000;
                if (autoRunIntervalDisplay) {
                    autoRunIntervalDisplay.textContent = `Interval: ${newVal}s`;
                }
                // If auto-run is enabled, restart with new interval
                if (autoRunCheckbox.checked) {
                    stopAutoRun();
                    startAutoRun();
                }
            }
        });
    }

    // Set initial interval display
    if (autoRunIntervalDisplay) {
        autoRunIntervalDisplay.textContent = `Interval: ${AUTO_RUN_INTERVAL_MS / 1000}s`;
    }

    function setRunButtonDisabled(disabled) {
        if (runButton) runButton.disabled = !!disabled;
    }

    function flashRunButton() {
        if (!runButton) return;
        runButton.classList.add('run-flash');
        setTimeout(() => runButton.classList.remove('run-flash'), 400);
    }

    function handlePhpRunResult(result) {
        if (uiElements.isOutputModeHtml) {
            uiElements.outputHtml = result.output;
        } else {
            uiElements.output = result.output;
        }
        uiElements.output_error = result.output_error;
        uiElements.phpVersionDisplay = result.version;
        uiElements.perfDataDisplay = result.executionTime;
        updateErrorBadge(countDiagnosticLines(result.output_error));
        // Highlight error in editor if present
        let errorInfo = parsePhpError(result.output_error);
        if (!errorInfo) errorInfo = parsePhpError(result.output);
        setEditorErrorMarker(editor.editorInstance, editor.currentEditor, errorInfo);
    }

    function handlePhpRunError(err) {
        uiElements.output_error = err.message;
        updateErrorBadge(countDiagnosticLines(err.message));
        setEditorErrorMarker(editor.editorInstance, editor.currentEditor, null);
    }

    function startAutoRun() {
        if (runInterval) clearInterval(runInterval);
        runInterval = setInterval(async () => {
            if (autoRunExecuting || editorSwitching) return;
            autoRunExecuting = true;
            setRunButtonDisabled(true);
            flashRunButton();
            try {
                const result = await php.runPHP(editor.getContent(), uiElements.phpVersionDropdown);
                handlePhpRunResult(result);
            } catch (err) {
                handlePhpRunError(err);
            }
            autoRunExecuting = false;
            setRunButtonDisabled(false);
        }, AUTO_RUN_INTERVAL_MS);
    }
    function stopAutoRun() {
        if (runInterval) clearInterval(runInterval);
        runInterval = null;
    }
    autoRunCheckbox.addEventListener("change", () => {
        if (autoRunCheckbox.checked) {
            startAutoRun();
        } else {
            stopAutoRun();
        }
    });
    // If checkbox is checked on load, start auto run
    if (autoRunCheckbox.checked) {
        startAutoRun();
    }

    // run button click handler with improved checks
    runButton.addEventListener("click", async () => {
        if (autoRunExecuting || editorSwitching) return;
        setRunButtonDisabled(true);
        try {
            const phpVersion = uiElements.phpVersionDropdown;
            if (!phpVersion) {
                uiElements.output_error = "Please select a PHP version.";
                setEditorErrorMarker(editor.editorInstance, editor.currentEditor, null);
                setRunButtonDisabled(false);
                return;
            }
            const result = await php.runPHP(editor.getContent(), phpVersion);
            handlePhpRunResult(result);
        } catch (err) {
            handlePhpRunError(err);
        }
        setRunButtonDisabled(false);
    });

    // editor switcher
    const editorDropdown = document.getElementById("editor-switcher");
    editorDropdown.addEventListener("change", async (event) => {
        editorSwitching = true;
        setRunButtonDisabled(true);
        try {
            await editor.switchEditor(event.target.value);
        } finally {
            editorSwitching = false;
            setRunButtonDisabled(false);
        }
    });

    // php version switcher
    const phpVersionDropdown = document.getElementById("php-version-switcher");
    phpVersionDropdown.addEventListener("change", async (event) => {
        const result = await php.runPHP(editor.getContent(), event.target.value);
        handlePhpRunResult(result);
    });

    // php example switcher
    const phpExampleDropdown = document.getElementById("php-example-switcher");
    phpExampleDropdown.addEventListener("change", async (event) => {
        const example = event.target.value;
        // automatically switch the output mode to HTML, if the example is phpinfo()
        if(example === "phpinfo") {
            uiElements.outputModeHtml = true;
        } else {
            uiElements.outputModeHtml = false;
        }
        let content = '';
        const isGithubPages = location.hostname.endsWith('github.io');
        if (isGithubPages) {
            // on GitHub Pages there is no PHP backend, so we load the php files as text files
            const response = await fetch(`examples/${example}.php`);
            content = await response.text();
        } else {
            // we have a PHP backend available
            const response = await fetch(`examples/_get_file.php?file=${example}`);
            content = await response.text();
        }
        editor.setContent(content);
        setEditorErrorMarker(editor.editorInstance, editor.currentEditor, null);
    });

    // Reset button: load the default hello world example and clear outputs/errors
    const resetButton = document.getElementById("reset-button");
    if (resetButton) {
        resetButton.addEventListener("click", async (event) => {
            event.preventDefault();
            // Clear output and error markers
            try {
                uiElements.output = '';
                updateErrorBadge(0);
                opcodeDumpText = '';
                if (opcodeOutput) opcodeOutput.textContent = 'Ready!';
                setOpcodeStatus('Compile the editor contents to see the opcodes.');
                if (resultTabs) resultTabs.show('output');
                uiElements.output_error = '';
                uiElements.phpVersionDisplay = '';
                uiElements.perfDataDisplay = '';
                setEditorErrorMarker(editor.editorInstance, editor.currentEditor, null);

                // Attempt to load the hello_world example from examples folder
                let content = '';
                const exampleName = 'hello_world';
                const isGithubPages = location.hostname.endsWith('github.io');
                if (isGithubPages) {
                    const resp = await fetch(`examples/${exampleName}.php`);
                    if (resp.ok) content = await resp.text();
                } else {
                    // When a backend is available use the helper endpoint if present
                    try {
                        const resp = await fetch(`examples/_get_file.php?file=${exampleName}`);
                        if (resp.ok) content = await resp.text();
                    } catch (e) {
                        // fallback to direct file fetch
                        const resp2 = await fetch(`examples/${exampleName}.php`);
                        if (resp2.ok) content = await resp2.text();
                    }
                }

                // If fetching failed, use a small builtin hello world
                if (!content) {
                    content = `<?php\n\n// Hello World example\necho 'Hello World!';\n`;
                }

                editor.setContent(content);
                // move focus to editor for keyboard users
                const editorEl = document.getElementById('editor');
                editorEl && editorEl.focus && editorEl.focus();
            } catch (err) {
                console.error('Reset failed:', err);
            }
        });
    }

    /* Output */

    // Output mode toggle checkbox (raw or html)
    // we need to store the original php raw output to toggle between raw and html
    // rendering html would strip out the html tags and display the text only,
    // converting it back would result in the loss of the original raw html text
    // so we store the raw output only once and toggle between raw and html rendering.
    const outputModeCheckbox = document.getElementById("output-mode-switcher");
    let phpRawOutput = '';
    outputModeCheckbox.addEventListener("click", () => {
        if (!phpRawOutput) {
            phpRawOutput = uiElements.output; // Store the raw output
        }
        if (outputModeCheckbox.checked) {
            uiElements.outputHtml = phpRawOutput; // Show as HTML
        } else {
            uiElements.output = phpRawOutput; // Show as raw text
        }
    });

    // Font size controls
    const fontDecrease = document.getElementById("font-decrease");
    const fontIncrease = document.getElementById("font-increase");
    if (fontDecrease && fontIncrease) {
        fontDecrease.addEventListener("click", () => editor.setFontSize(editor.getFontSize() - 1));
        fontIncrease.addEventListener("click", () => editor.setFontSize(editor.getFontSize() + 1));
    }

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
            if (e.key === "+" || e.key === "=") {
                editor.setFontSize(editor.getFontSize() + 1);
                e.preventDefault();
            } else if (e.key === "-" || e.key === "_") {
                editor.setFontSize(editor.getFontSize() - 1);
                e.preventDefault();
            }
	}
    });
});
}

/* Exported so a Node test harness can import them; unused by the page itself. */
export { escapeHtml, renderOpcodeLine, renderOpcodeDump, setupResultTabs, parsePhpError };
