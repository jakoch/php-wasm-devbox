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

    async #loadWasmBinary(php_version) {
        if (!PHP.#wasmModuleCache[php_version]) {
            const wasmUrl = `assets/wasm/php-${php_version}-web.wasm`;
            PHP.#wasmModuleCache[php_version] = fetch(wasmUrl).then(res => res.arrayBuffer());
        }
        return PHP.#wasmModuleCache[php_version];
    }

    async #loadWasmModule(php_version) {
        // if the PHP module is already loaded, return the runPHP function
        if (this.#runPhp && this.#version === php_version) {
            return this.#runPhp;
        }

        // load the WASM module dynamically based on the PHP version
        const modulePath = `assets/wasm/php-${php_version}-web.mjs`;
        const createPhpModule = (await import(modulePath)).default;

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
            const timer = new Timer("PHP Script");

            runPhp(code); // directly run

            const elapsedTime = timer.stop().totalTime;
            return {
                output: this.stdout,
                output_error: this.stderr,
                version: this.version,
                executionTime: timer.formatTime(elapsedTime)
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
        return editor?.value || "";
    }

    setContent(content) {
        if (this.#editorInstance?.setValue) {
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
                    //newEditor.className = "resizable-content";
                    newEditor.style.height = "100%"; // Allow flexbox/CSS to control height
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

                    resolve(monacoInstance);
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
  const aParts = a.version.split('.').map(Number);
  const bParts = b.version.split('.').map(Number);
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
        option.value = version.version;
        option.textContent = "PHP " + version.version; // label the option with "PHP " prefix
        phpVersionDropdown.appendChild(option);
    }
    // Set the default version to the latest one
    if (versions.length > 0) {
        phpVersionDropdown.value = versions[0].version; // Set the first version as default
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
        // Highlight error in editor if present
        let errorInfo = parsePhpError(result.output_error);
        if (!errorInfo) errorInfo = parsePhpError(result.output);
        setEditorErrorMarker(editor.editorInstance, editor.currentEditor, errorInfo);
    }

    function handlePhpRunError(err) {
        uiElements.output_error = err.message;
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
    // Keyboard shortcuts for font size
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
