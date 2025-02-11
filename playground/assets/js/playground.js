import phpBinary from '../wasm/php-8.4.3-web.mjs';
//import phpBinary from '../wasm/php-8.4.0-web.mjs';
// createPhpModule

// Setup Playground
document.addEventListener("DOMContentLoaded", () => {
    const editor = initEditor();
    const output = document.getElementById("output");
    const runButton = document.getElementById("run");

    runButton.addEventListener("click", () => runPhpCode(editor, output));
});

// Initialize CodeMirror editor
function initEditor() {
    return CodeMirror.fromTextArea(document.getElementById("editor"), {
        mode: "text/x-php",
        lineNumbers: true,
        theme: "default"
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

async function runPhpCode(editor, output) {
    output.textContent = "Running...";
    try {
        const runPhp = await PHP.loadPhp();
        const script = editor.getValue();
        runPhp(script);

        // delay to ensure buffer is ready
        setTimeout(() => {
            output.textContent = `${PHP.buffer.join("\n")}`;
        }, 100);
    } catch (error) {
        output.textContent = `JS Error: ${error.message}`;
    }
}
