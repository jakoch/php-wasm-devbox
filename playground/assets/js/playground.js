import phpBinary from '../wasm/php-8.4.3-web.mjs';
//import phpBinary from '../wasm/php-8.4.0-web.mjs';
// createPhpModule

// Setup Playground
document.addEventListener("DOMContentLoaded", () => {
    const editor = initEditor();                                // code input
    const output = document.getElementById("output");           // result output
    const performance = document.getElementById("perf-data");   // performance data
    const php_version = document.getElementById("php-version"); // php version

    const runButton = document.getElementById("run");           // run button
    runButton.addEventListener("click", () => runPhpCode(editor, output, performance, php_version));
});

// Initialize CodeMirror editor
function initEditor() {
    const codeElement = document.getElementById("editor");
    return CodeMirror.fromTextArea(codeElement, {
        mode: "text/x-php",
        matchBrackets: true,
        lineNumbers: true,
        indentUnit: 4,
        indentWithTabs: true,
        theme: 'monokai',
        gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"],
        extraKeys: { Tab: "indentMore" }
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

        const { ccall } = await phpBinary({
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

        PHP.version = ccall("phpw_exec", "string", ["string"], ["phpversion();"]) || "unknown";
        console.log("PHP wasm %s loaded.", PHP.version);

        // The source-code from the editor input field needs to be properly
        // wrapped in PHP escaped tags (&lt;?, ?&gt;)!
        PHP.runPhp = (code) => ccall("phpw_run", null, ["string"], [`?>${code}`]);

        return PHP.runPhp;
    }
};

async function runPhpCode(editor, output, performance, php_version) {
    output.textContent = "Running...";
    try {
        const runPhp = await PHP.loadPhp();
        const script = editor.getValue();

        const timer = new Timer("PHP Script");
        runPhp(script);
        const elapsedTime = timer.stop().totalTime;

        // delay to ensure buffer is ready
        setTimeout(() => {
            output.textContent = `${PHP.buffer.join("\n")}`;
            php_version.textContent = `${PHP.version}`;
            performance.textContent = `Execution time: ${elapsedTime} ms`;
        }, 100);
    } catch (error) {
        output.textContent = `JS Error: ${error.message}`;
    }
}
