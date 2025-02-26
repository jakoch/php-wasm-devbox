let createPhpModule = null; // Store the createPhpModule function from the PHP WASM module
let editorInstance = null; // Store the actual editor instance, not just the type.
let currentEditor = "monaco"; // Keep track of the editor type

/**
 * Get the textarea element with the id "editor".
 */
function getEditorElement() {
    const editor = document.getElementById("editor");
    if (!editor) {
        console.warn("Editor textarea element not found! Creating a new one.");
    }
    return editor;
}

/**
 * Get the content of the editorInstance.
 * Or get the content of the initial textarea element if the editorInstance is not available.
 */
function getEditorContent() {
    const editor = getEditorElement();
    if (editorInstance && typeof editorInstance.getValue === "function") {
        return editorInstance.getValue();
    }
    return editor.value;
}

function setEditorContent(content) {
    const editor = getEditorElement();
    if (editor) {
        editor.value = content;
    }
}

/**
 * Initialize the editor based on the currentEditor type (global var).
 */
async function initEditor() {
    if (currentEditor === "monaco") {
        editorInstance = await initMonacoEditor();
    } else if (currentEditor === "codemirror") {
        editorInstance = initCodeMirror();
    }
	return editorInstance;
}

async function switchEditor(editorType) {
    // Destroy current editor instance properly
    if (editorInstance) {
        if (currentEditor === "monaco") {
            editorInstance.dispose();
        } else if (currentEditor === "codemirror") {
            editorInstance.toTextArea();
        }
    }

    // Store old content
    const content = getEditorContent();
    // Initialize new editor
    if (editorType === "monaco") {
        editorInstance = await initMonacoEditor();
    } else {
        editorInstance = initCodeMirror();
    }
    // set content to the new editor
    if (editorInstance.setValue) {
        editorInstance.setValue(content);
    }
    // announce the new editor type
    currentEditor = editorType;
}

// Initialize CodeMirror editor
function initCodeMirror() {
    const editor = getEditorElement();
    // if the editor is already a CodeMirror instance, return it
    if (editor.classList.contains("CodeMirror")) {
        return editorInstance;
    }

    return CodeMirror.fromTextArea(editor, {
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

// Initialize Monaco editor
function initMonacoEditor() {
    return new Promise((resolve) => {
        require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs" } });
        require(["vs/editor/editor.main"], () => {
            console.log("Monaco Loaded:", typeof monaco !== "undefined");

            const editor = getEditorElement();

            // get the content of the textarea
            const content = getEditorContent();

            // Replace the textarea with a div element
            const newEditor = document.createElement("div");
            newEditor.id = "editor";
            newEditor.style.width = "100%";
            newEditor.style.height = "400px";
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
                lineNumbers: "on",
            });
            console.log("Monaco uses Typescript Version:", monaco.languages.typescript.typescriptVersion);
            // how to show the monaco version in the console?
            // console.log("Monaco Version:", monaco.editor.version);
            resolve(monacoInstance);
        });
    });
}

const PHP = {
    buffer: [],
    runPhp: null,
    version: '',

    async loadPhp() {
        if (PHP.runPhp) {
            return PHP.runPhp;
        }

        const { ccall } = await createPhpModule({
            print(data) {
                if (!data) {
                    return;
                }
                if (PHP.buffer.length) {
                    PHP.buffer.push("\n");
                }
                PHP.buffer.push(data);
            }
        });

        // Get the PHP version
        PHP.version = ccall("phpw_exec", "string", ["string"], ["phpversion();"]) || "unknown";
        console.log("PHP wasm %s loaded.", PHP.version);

        // Run PHP code
        // The source-code from the editor input field needs the usual PHP opening tag: <?php
        PHP.runPhp = (code) => ccall("phpw_run", null, ["string"], [`?>${code}`]);

        return PHP.runPhp;
    }
};

async function runPhpCode(output) {
    if (!editorInstance) {
        output.textContent = "Editor not initialized!";
        return;
    }

    // get the selected PHP version
    const phpVersionDropdown = document.getElementById("php-version-switcher");
    if (!phpVersionDropdown) {
        output.textContent = "PHP version selector not found!";
        return;
    }
    const php_version = phpVersionDropdown.options[phpVersionDropdown.selectedIndex].value;
    if (!php_version) {
        output.textContent = "Invalid PHP version!";
        return;
    }

    // Dynamically import the WASM module based on the selected PHP version
    // The phpdoc project calls the function that loads the PHP WASM module "createPhpModule".
    // It is set using the EXPORT_NAME variable when building the WASM module with Emscripten.
    // Keeping the original function name allows testing the official PHP WASM module from phpdoc
    // by simply copying it to the wasm folder and using the version switcher.
    const modulePath = `../wasm/php-${php_version}-web.mjs`;
    createPhpModule = (await import(modulePath)).default;

    output.textContent = "Running...";

    PHP.buffer = []; // clear buffer

    try {
        const runPhp = await PHP.loadPhp();
        const script = editorInstance.getValue();

        const timer = new Timer("PHP Script");
        await new Promise((resolve) => {
            runPhp(script);
            resolve();
        });
        const elapsedTime = timer.stop().totalTime;

        // Display the output
        // Using `${PHP.buffer}` will not work, because the PHP.buffer array is
        // being converted to a string using the default Array.prototype.toString
        // method, which joins the array elements with commas. To avoid this,
        // we can use the join method (to join all buffer elements without commas).
        output.textContent = PHP.buffer.join('');

        // Update PHP version display
        const php_version = document.getElementById("php-version");
        php_version.textContent = `${PHP.version}`;

        // Update performance display
        const performance = document.getElementById("perf-data");
        performance.textContent = `Execution time: ${elapsedTime} ms`;
    } catch (error) {
        output.textContent = `JS Error: ${error.message}`;
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

// Setup Playground Interactions
document.addEventListener("DOMContentLoaded", async () => {
    editorInstance = await initEditor();                        // initialize editor

    const result = document.getElementById("output");

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
    runButton.addEventListener("click", () => runPhpCode(result));

    // save button
    const saveButton = document.getElementById("save-button");
    saveButton.addEventListener("click", () => {
        const content = getEditorContent();
        // timestamp format is YYYYMMDD-HHMM
        const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
        // file name format is "index-YYYYMMDD-HHMM.php"
        const filename = `index-${timestamp}.php`;
        saveToFile(content, filename);
    });

    // reset button
    const resetButton = document.getElementById("reset-button");
    resetButton.addEventListener("click", () => {
        setEditorContent("<?php\n\necho 'Hello, World!';\n");
        result.textContent = "Ready!";
    });

    // editor switcher
    const editorDropdown = document.getElementById("editor-switcher");
    editorDropdown.addEventListener("change", (event) => switchEditor(event.target.value));

    // php version switcher
    const phpVersionDropdown = document.getElementById("php-version-switcher");
    phpVersionDropdown.addEventListener("change", async (event) => {
        await runPhpCode(result);
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
            phpRawOutput = result.textContent; // Store raw output once
        }
        if (outputModeCheckbox.checked) {
            result.innerHTML = phpRawOutput; // Show as HTML
        } else {
            result.textContent = phpRawOutput; // Show as raw text
        }
    });
});
