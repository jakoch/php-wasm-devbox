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
    #buffer_stdout = [];
    #buffer_stderr = [];
    #runPhp = null;
    #version = '';

    constructor() {
        // Initialize static properties
        if (!PHP.buffer_stdout) {
            PHP.buffer_stdout = [];
            PHP.buffer_stderr = [];
            PHP.runPhp = null;
            PHP.version = '';
        }
    }

    async loadWasmModule(php_version) {
        // if the PHP module is already loaded, return the runPhp function
        if (PHP.runPhp && PHP.version === php_version) {
            return PHP.runPhp;
        }
        // load the PHP WASM module
        const modulePath = `../wasm/php-${php_version}-web.mjs`;
        const createPhpModule = (await import(modulePath)).default;

        // options for the PHP module
        const phpModuleOptions = {
            print: (data) => {
                if (!data) return
                if (PHP.buffer_stdout.length) PHP.buffer_stdout.push('\n');
                PHP.buffer_stdout.push(data);
            },
            printErr: (data) => {
                if (!data) return
                if (PHP.buffer_stderr.length) PHP.buffer_stderr.push('\n');
                PHP.buffer_stderr.push(data);
            }
        };

        // init the PHP module
        const { ccall } = await createPhpModule(phpModuleOptions);

        // get PHP version
        PHP.version = ccall("phpw_exec", "string", ["string"], ["phpversion();"]) || "unknown";
        //console.log(`PHP wasm ${PHP.version} loaded.`);

        // prepare the runPhp function
        PHP.runPhp = (code) => ccall("phpw_run", null, ["string"], [`?>${code}`]);
        return PHP.runPhp;
    }

    async runPHP(code, php_version) {
        //console.log(`Running this code with PHP ${php_version}:`, code);
        if (!php_version) {
            throw new Error("Invalid PHP version!");
        }

        // clear buffers
        PHP.buffer_stdout = [];
        PHP.buffer_stderr = [];

        try {
            const runPhp = await this.loadWasmModule(php_version);
            const timer = new Timer("PHP Script");
            const script = code;

            await new Promise((resolve) => {
                runPhp(script);
                resolve();
            });

            //const converted_output = UTF8.read_string(PHP.buffer.join(''));

            const elapsedTime = timer.stop().totalTime;
            return {
                output: PHP.buffer_stdout.join(''), // stdout
                output_error: PHP.buffer_stderr.join(''), // stderr
                version: PHP.version,
                executionTime: timer.formatTime(elapsedTime)
            };
        } catch (error) {
            throw new Error(`PHP execution failed: ${error.message}`);
        }
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

    constructor() {
        // Initialize immediately
        this.init();
    }

    async init() {
        await this.switchEditor(this.#currentEditor);
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
                    newEditor.style.height = "300px";
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
}

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
    const response = await fetch('assets/wasm/php_versions.json');
    const versions = await response.json();
    phpVersionDropdown.innerHTML = ''; // Clear existing options
    // sort versions by value, highest first
    versions.sort((a, b) => compareVersions(a.value, b.value));
    // Populate the dropdown with the versions
    for (const version of versions) {
        const option = document.createElement('option');
        option.value = version.value;
        option.textContent = "PHP " + version.value; // label the option with "PHP " prefix
        phpVersionDropdown.appendChild(option);
    }
    // Set the default version to the latest one
    if (versions.length > 0) {
        phpVersionDropdown.value = versions[0].value; // Set the first version as default
    }
}

// Load the examples list and populate the dropdown
// This function fetches the examples from a static JSON file or falls back to hardcoded examples.
async function loadExamplesList() {
  let examples = [];
  const resp = await fetch('examples/examples.json');
  examples = await resp.json();
  const phpExampleDropdown = document.getElementById("php-example-switcher");
  phpExampleDropdown.innerHTML = '';
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

// Setup Playground Interactions
document.addEventListener("DOMContentLoaded", async () => {
    const php = new PHP();
    const editor = new CodeEditor();

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
    runButton.addEventListener("click", async () => {
        const result = await php.runPHP(editor.getContent(), uiElements.phpVersionDropdown);
        if(uiElements.isOutputModeHtml) {
            uiElements.outputHtml = result.output;
        } else {
            uiElements.output = result.output;
        }
        uiElements.output_error = result.output_error;
        uiElements.phpVersionDisplay = result.version;
        uiElements.perfDataDisplay = result.executionTime;
    });

    // auto run checkbox
    const autoRunCheckbox = document.getElementById("auto-run");
    let runInterval = null; // debounce the run interval (do not run too frequently)
    autoRunCheckbox.addEventListener("click", () => {
        if (autoRunCheckbox.checked) {
            runInterval = setInterval(async () => {
                console.log("Running PHP code continuously ...");
                const result = await php.runPHP(editor.getContent(), uiElements.phpVersionDropdown);
                if (uiElements.isOutputModeHtml) {
                    uiElements.outputHtml = result.output;
                } else {
                    uiElements.output = result.output;
                }
                uiElements.output_error = result.output_error;
                uiElements.phpVersionDisplay = result.version;
                uiElements.perfDataDisplay = result.executionTime;
            }, 2000);
        } else {
            clearInterval(runInterval);
        }
    });

    // save button
    const saveButton = document.getElementById("save-button");
    saveButton.addEventListener("click", () => {
        const content = editor.getContent();
        // timestamp format is YYYYMMDD-HHMM
        const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
        // file name format is "index-YYYYMMDD-HHMM.php"
        const filename = `index-${timestamp}.php`;
        saveToFile(content, filename);
    });

    // copy button
    const copyButton = document.getElementById("copy-button");
    copyButton.addEventListener("click", () => {
        const content = editor.getContent();
        navigator.clipboard.writeText(content).then(() => {
            console.log("Copied to clipboard:", content);
        }).catch((error) => {
            console.error("Failed to copy to clipboard:", error);
        });
    });

    // reset button
    const resetButton = document.getElementById("reset-button");
    resetButton.addEventListener("click", () => {
        editor.setContent("<?php\n\necho 'Hello, World!';\n");
        uiElements.output = "Ready!";
        uiElements.outputModeHtml = false; // reset to raw output
        uiElements.output_error = "No Errors!";
        uiElements.phpVersionDisplay = "0.0.0";
        uiElements.perfDataDisplay = "0s";
    });

    // editor switcher
    const editorDropdown = document.getElementById("editor-switcher");
    editorDropdown.addEventListener("change", (event) => editor.switchEditor(event.target.value));

    // php version switcher
    const phpVersionDropdown = document.getElementById("php-version-switcher");
    phpVersionDropdown.addEventListener("change", async (event) => {
        const result = await php.runPHP(editor.getContent(), event.target.value);
        if(uiElements.isOutputModeHtml) {
            uiElements.outputHtml = result.output;
        } else {
            uiElements.output = result.output;
        }
        uiElements.output_error = result.output_error;
        uiElements.phpVersionDisplay = result.version;
        uiElements.perfDataDisplay = result.executionTime;
    });

    // php example switcher
    const phpExampleDropdown = document.getElementById("php-example-switcher");
    phpExampleDropdown.addEventListener("change", async (event) => {
        const example = event.target.value;
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
});
