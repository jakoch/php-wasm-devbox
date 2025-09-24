/**
 * Multi-Run Editor Overview
 * -------------------------
 * The class PHP is used to manage the PHP WASM module and its interactions.
 * The class CodeEditor is used to manage the editor instance and its interactions.
 * The class VersionPanel manages individual PHP version execution panels.
 * The event listeners are added to the UI elements to handle the interactions.
 */

import { Timer } from './timer.js';

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
    static wasmModuleCache = {};

    #buffer_stdout = [];
    #buffer_stderr = [];
    #runPhp = null;
    #version = '';

    // Static method to get the base path for WASM modules
    // This needs to handle gh-pages and local development paths correctly
    static getBasePath = () => {
        const match = location.pathname.match(/^\/(php-wasm-devbox)(\/|$)/);
        return match ? `/${match[1]}` : '';
    };

    // Base path for WASM modules, set once during class initialization
    #basePath = PHP.getBasePath();

    async #loadWasmBinary(php_version) {
        if (!PHP.wasmModuleCache[php_version]) {
            const wasmUrl = `${this.#basePath}/assets/wasm/php-${php_version}-web.wasm`;
            PHP.wasmModuleCache[php_version] = fetch(wasmUrl)
                .then(res => {
                    if (!res.ok) throw new Error(`Failed to fetch WASM: ${res.statusText}`);
                    return res.arrayBuffer();
                });
        }
        return PHP.wasmModuleCache[php_version];
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
        const phpModuleOptions = {
            wasmBinary,
            print: (data) => {
                if (!data) return;
                if (this.#buffer_stdout.length) this.#buffer_stdout.push('\n');
                this.#buffer_stdout.push(data);
            },
            printErr: (data) => {
                if (!data) return;
                if (this.#buffer_stderr.length) this.#buffer_stderr.push('\n');
                this.#buffer_stderr.push(data);
            }
        };

        // initialize the PHP WASM module
        const { ccall } = await createPhpModule(phpModuleOptions);

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
        } else {
            const editor = this.getEditorElement();
            if (editor) {
                editor.value = content;
            }
            this.updateStatusBar();
        }
    }

    updateStatusBar() {
        const content = this.getContent();
        if (this.#statusBar.size) {
            this.#statusBar.size.textContent = `Size: ${new Blob([content]).size} bytes`;
        }
    }

    async switchEditor(editorType) {
        if (this.#currentEditor === editorType) return;

        const content = this.getContent();
        const editorElement = this.getEditorElement();
        if (!editorElement) return;

        // Dispose of the current editor
        if (this.#editorInstance) {
            if (this.#currentEditor === "monaco" && this.#editorInstance.dispose) {
                this.#editorInstance.dispose();
            } else if (this.#currentEditor === "codemirror" && this.#editorInstance.toTextArea) {
                this.#editorInstance.toTextArea();
            }
            this.#editorInstance = null;
        }

        this.#currentEditor = editorType;

        if (editorType === "monaco") {
            this.#editorInstance = await this.#initMonacoEditor(content);
        } else if (editorType === "codemirror") {
            this.#editorInstance = this.#initCodeMirrorEditor(content);
        }

        // Content is already set in the init methods, no need to call setContent again
        // this.setContent(content);
    }

    async #initMonacoEditor(content) {
        const editorElement = this.getEditorElement();

        // Load Monaco
        await new Promise((resolve) => {
            require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs' } });
            require(['vs/editor/editor.main'], resolve);
        });

        // Create a new div element for Monaco and try to size it using the
        // surrounding editor container (editor-body) which more accurately
        // represents available space than the textarea itself.
        const newEditor = document.createElement("div");
        newEditor.id = "editor";
        try {
            let height = 0;
            const editorBody = document.getElementById('editor-body');
            if (editorBody && editorBody.clientHeight) {
                height = editorBody.clientHeight;
            } else {
                const rect = editorElement.getBoundingClientRect();
                height = (rect && rect.height) ? Math.round(rect.height) : editorElement.offsetHeight || 300;
            }
            // Ensure a sane minimum
            if (!height || height < 100) height = 300;
            newEditor.style.height = height + 'px';
            // allow the editor to expand to full width
            newEditor.style.width = '100%';
        } catch (e) {
            newEditor.style.height = "300px";
            newEditor.style.width = '100%';
        }
        editorElement.replaceWith(newEditor);

        this.#editorInstance = window.monaco.editor.create(newEditor, {
            value: content,
            language: 'php',
            theme: 'vs-dark',
            fontSize: this.#fontSize,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'on',
            tabSize: 4,
            insertSpaces: true,
            lineNumbers: "on",
            autoClosingQuotes: 'always',
            wordBasedSuggestions: true,
            showFoldingControls: "always",
            smoothScrolling: true,
            links: true
        });

        // Force initial layout
        this.#editorInstance.layout();

        // Ensure line numbers are visible and force layout after the browser has
        // painted and computed styles. Using two requestAnimationFrame calls is
        // a robust path; additionally, if the editor is not yet visible, use an
        // IntersectionObserver to trigger layout when it becomes visible.
        const doLayout = () => {
            try {
                this.#editorInstance.updateOptions({ lineNumbers: "on" });
                this.#editorInstance.layout();
            } catch (e) {
                // ignore layout errors during early teardown
            }
        };

        // If the new editor has reasonable height, run the double RAF layout.
        if (newEditor.clientHeight && newEditor.clientHeight > 50) {
            requestAnimationFrame(() => requestAnimationFrame(doLayout));
        } else if (typeof IntersectionObserver !== 'undefined') {
            // Wait until the editor is visible in the viewport before laying out
            const io = new IntersectionObserver((entries, obs) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        doLayout();
                        obs.disconnect();
                        break;
                    }
                }
            });
            io.observe(newEditor);
            // As a safety fallback, also schedule a RAF layout after a short delay
            setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(doLayout)), 200);
        } else {
            // Last-resort fallback
            setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(doLayout)), 100);
        }

        return this.#editorInstance;
    }

    #initCodeMirrorEditor(content) {
        const editorElement = this.getEditorElement();

        // Create a new textarea element for CodeMirror
        const newEditor = document.createElement("textarea");
        newEditor.id = "editor";
        newEditor.value = content;
        newEditor.style.height = "300px";
        editorElement.replaceWith(newEditor);

        if (!window.CodeMirror) {
            console.error("CodeMirror not loaded!");
            return;
        }

        this.#editorInstance = window.CodeMirror.fromTextArea(newEditor, {
            lineNumbers: true,
            mode: 'text/x-php',
            theme: 'monokai',
            lineWrapping: true,
            tabSize: 4,
            indentWithTabs: false,
            gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"],
            matchBrackets: true,
            autoRefresh: true,
            styleActiveLine: true,
            extraKeys: { Tab: "indentMore" }
        });

        this.#editorInstance.on('cursorActivity', () => {
            const cursor = this.#editorInstance.getCursor();
            if (this.#statusBar.cursor) {
                this.#statusBar.cursor.textContent = `Ln: ${cursor.line + 1}, Col: ${cursor.ch + 1}`;
            }
        });

        this.#editorInstance.on('change', () => {
            this.updateStatusBar();
        });

        // Apply font size
        const codeMirrorElement = this.#editorInstance.getWrapperElement();
        if (codeMirrorElement) {
            codeMirrorElement.style.fontSize = this.#fontSize + 'px';
        }

        return this.#editorInstance;
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

/**
 * VersionPanel class to manage individual PHP version execution panels.
 */
class VersionPanel {
    #id;
    #php;
    #container;
    #versionSelect;
    #runButton;
    #removeButton;
    #outputElement;
    #errorElement;
    #versionDisplay;
    #perfDisplay;
    #outputModeCheckbox;

    constructor(id, availableVersions) {
        this.#id = id;
        this.#php = new PHP();
        this.#createPanel(availableVersions);
    }

    #createPanel(availableVersions) {
        this.#container = document.createElement('div');
        this.#container.className = 'card bg-dark';
        this.#container.innerHTML = `
<div class="card bg-dark text-white border-secondary">
  <!-- Top Header -->
  <div class="card-header bg-secondary d-flex justify-content-between align-items-center">
    <!-- Left side: title + selected version -->
    <div class="d-flex align-items-center gap-2">
      <i class="bi bi-code-slash fs-3"></i>
      <span class="fw-bold fs-4">PHP Version ${this.#id}:</span>
      <span id="php-version-${this.#id}" class="fw-bold fs-4">0.0.0</span>
    </div>

    <!-- Right side: controls -->
    <div class="d-flex align-items-center gap-3">
      <!-- Toggle integrated into header -->
      <div class="form-check form-switch m-0">
        <input class="form-check-input bg-dark border border-light" type="checkbox" id="output-mode-${this.#id}">
        <label class="form-check-label small" for="output-mode-${this.#id}">HTML Output</label>
      </div>

      <!-- PHP version select -->
      <label for="version-select-${this.#id}" class="visually-hidden">PHP Version</label>
      <select id="version-select-${this.#id}" class="form-select form-select-sm w-auto">
        <option disabled selected>Select Version</option>
        ${availableVersions.map(v => `<option value="${v}">PHP ${v}</option>`).join('')}
      </select>

      <!-- Action buttons -->
      <button id="run-button-${this.#id}" class="btn btn-success btn-sm">
        <i class="bi bi-play-fill"></i> Run
      </button>
      <button id="remove-button-${this.#id}" class="btn btn-danger btn-sm">
        <i class="bi bi-trash"></i>
      </button>
    </div>
  </div>

  <!-- Body -->
  <div class="card-body">
    <!-- Standard Output -->
    <div class="position-relative mb-3">
      <pre id="output-${this.#id}" class="bg-black text-white border border-success rounded p-2 font-monospace" style="min-height:100px;">Ready!</pre>
      <small class="position-absolute top-0 end-0 m-2 text-success">Standard Output</small>
      <small class="position-absolute" style="top: 2rem; right: 0.5rem;" class="text-white-50">Performance: <span id="perf-data-${this.#id}" class="fw-bold">0ms</span></small>
    </div>

    <!-- Standard Error -->
    <div class="position-relative">
      <pre id="error-${this.#id}" class="bg-black border border-danger rounded p-2 font-monospace text-danger" style="min-height:50px;">No Errors!</pre>
      <small class="position-absolute top-0 end-0 m-2 text-danger">Standard Error</small>
    </div>
  </div>
</div>
        `;

        // Get references to elements
        this.#versionSelect = this.#container.querySelector(`#version-select-${this.#id}`);
        this.#runButton = this.#container.querySelector(`#run-button-${this.#id}`);
        this.#removeButton = this.#container.querySelector(`#remove-button-${this.#id}`);
        this.#outputElement = this.#container.querySelector(`#output-${this.#id}`);
        this.#errorElement = this.#container.querySelector(`#error-${this.#id}`);
        this.#versionDisplay = this.#container.querySelector(`#php-version-${this.#id}`);
        this.#perfDisplay = this.#container.querySelector(`#perf-data-${this.#id}`);
        this.#outputModeCheckbox = this.#container.querySelector(`#output-mode-${this.#id}`);

        // Set default version if available
        if (availableVersions.length > 0) {
            this.#versionSelect.value = availableVersions[0];
            this.#versionDisplay.textContent = availableVersions[0];
        }

        // Add event listeners
        this.#runButton.addEventListener('click', () => this.runCode());
        this.#removeButton.addEventListener('click', () => this.remove());
        this.#versionSelect.addEventListener('change', () => {
            this.#versionDisplay.textContent = this.#versionSelect.value || "Select Version";
            this.runCode();
        });
        this.#outputModeCheckbox.addEventListener('change', () => this.#toggleOutputMode());
    }

    get container() {
        return this.#container;
    }

    async runCode(code = null) {
        if (!code) {
            // Get code from shared editor
            code = editor.getContent();
        }

        const version = this.#versionSelect.value;
        if (!version) {
            if (this.#errorElement) this.#errorElement.textContent = "Please select a PHP version.";
            return;
        }

        this.#runButton.disabled = true;
        this.#runButton.innerHTML = '<i class="bi bi-hourglass-split" aria-hidden="true"></i> Running...';

        try {
            const result = await this.#php.runPHP(code, version);
            this.#handleResult(result);
        } catch (err) {
            if (this.#errorElement) this.#errorElement.textContent = err.message;
        } finally {
            this.#runButton.disabled = false;
            this.#runButton.innerHTML = '<i class="bi bi-play-fill" aria-hidden="true"></i> <span class="ps-1">Run</span>';
        }
    }

    #handleResult(result) {
        if (this.#outputModeCheckbox.checked) {
            this.#outputElement.innerHTML = result.output;
        } else {
            this.#outputElement.textContent = result.output;
        }
        if (this.#errorElement) this.#errorElement.textContent = result.output_error || "No Errors!";
        this.#versionDisplay.textContent = result.version;
        if (this.#perfDisplay) this.#perfDisplay.textContent = result.executionTime;
    }

    #toggleOutputMode() {
        const currentContent = this.#outputElement.textContent;
        if (this.#outputModeCheckbox.checked) {
            this.#outputElement.innerHTML = currentContent;
        } else {
            this.#outputElement.textContent = currentContent;
        }
    }

    remove() {
        if (this.#container.parentNode) {
            this.#container.parentNode.removeChild(this.#container);
        }
        // Remove from global array
        const index = versionPanels.indexOf(this);
        if (index > -1) {
            versionPanels.splice(index, 1);
        }
        // Clean up PHP instance
        this.#php.unload();
    }
}

// Global variables
let editor;
let availableVersions = [];
let versionPanels = [];
let panelCounter = 1;

/**
 * Save content to a file
 */
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
    try {
        const response = await fetch(`${PHP.getBasePath()}assets/wasm/php-versions.json`);
        const versions = await response.json();
        versions.sort(compareVersions);
        availableVersions = versions;
    } catch (error) {
        console.error("Error loading PHP versions:", error);
        availableVersions = []; // or some default
    }
}

// Load the examples list json and populate the dropdown
async function loadExamplesList() {
    try {
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
    } catch (error) {
        console.error("Error loading examples list:", error);
    }
}

// load version.json file to display the application version
async function loadVersion() {
    try {
        const response = await fetch('version.json');
        const versionData = await response.json();
        const versionElement = document.getElementById("app-version");
        versionElement.textContent = `PHP-WASM Multi-Run Editor v${versionData.version} #${versionData.git_hash}`;
    } catch (error) {
        console.error("Error loading version data from version.json:", error);
    }
}

function addVersionPanel() {
    const panel = new VersionPanel(panelCounter++, availableVersions);
    versionPanels.push(panel);
    document.getElementById('version-panels-container').appendChild(panel.container);
}

function runAllVersions() {
    const code = editor.getContent();
    versionPanels.forEach(panel => panel.runCode(code));
}

// Initialize the application
document.addEventListener("DOMContentLoaded", async () => {
    // Load data
    await loadPhpVersions();
    await loadExamplesList();
    await loadVersion();

    // Initialize editor
    editor = new CodeEditor();

    // Add initial version panel
    addVersionPanel();

    // Event listeners
    document.getElementById('add-version-button').addEventListener('click', addVersionPanel);
    document.getElementById('run-all-button').addEventListener('click', runAllVersions);

    // Editor switcher
    const editorDropdown = document.getElementById("editor-switcher");
    editorDropdown.addEventListener("change", async (event) => {
        await editor.switchEditor(event.target.value);
    });

    // PHP example switcher
    const phpExampleDropdown = document.getElementById("php-example-switcher");
    phpExampleDropdown.addEventListener("change", async (event) => {
        const example = event.target.value;
        let content = '';
        const isGithubPages = location.hostname.endsWith('github.io');
        if (isGithubPages) {
            const response = await fetch(`examples/${example}.php`);
            content = await response.text();
        } else {
            const response = await fetch(`examples/_get_file.php?file=${example}`);
            content = await response.text();
        }
        editor.setContent(content);
    });

    // Reset button
    const resetButton = document.getElementById("reset-button");
    resetButton.addEventListener("click", async (event) => {
        event.preventDefault();
        let content = '';
        const exampleName = 'hello_world';
        const isGithubPages = location.hostname.endsWith('github.io');
        if (isGithubPages) {
            const resp = await fetch(`examples/${exampleName}.php`);
            if (resp.ok) content = await resp.text();
        } else {
            try {
                const resp = await fetch(`examples/_get_file.php?file=${exampleName}`);
                if (resp.ok) content = await resp.text();
            } catch (e) {
                const resp2 = await fetch(`examples/${exampleName}.php`);
                if (resp2.ok) content = await resp2.text();
            }
        }

        if (!content) {
            content = `<?php\n\n// Hello World example\necho 'Hello World!';\n`;
        }

        editor.setContent(content);
        const editorEl = document.getElementById('editor');
        editorEl && editorEl.focus && editorEl.focus();
    });

    // Load file button
    const loadFileButton = document.getElementById("load-file-button");
    loadFileButton.addEventListener("click", () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.php';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => editor.setContent(e.target.result);
                reader.readAsText(file);
            }
        };
        input.click();
    });

    // Save button
    const saveButton = document.getElementById("save-button");
    saveButton.addEventListener("click", () => {
        const content = editor.getContent();
        const now = new Date();
        const filename = `multi-${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}-${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}.php`;
        saveToFile(content, filename);
    });

    // Copy button
    const copyButton = document.getElementById("copy-button");
    copyButton.addEventListener("click", async () => {
        const content = editor.getContent();
        try {
            await navigator.clipboard.writeText(content);
        } catch (err) {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = content;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
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

    // Navigation links
    document.getElementById('playground-link').addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = 'index.html';
    });

    document.getElementById('multi-run-link').addEventListener('click', (e) => {
        e.preventDefault();
        // Already on multi-run page
    });

    document.getElementById('help-link').addEventListener('click', (e) => {
        const helpContainer = document.getElementById('help-container');
        helpContainer.classList.toggle('d-none');
    });
});
