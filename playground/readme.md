# Issues for PHP-WASM Playground

## Backlog (Ideas)

- [ ] "Multi Version Run"
  - Allow users to execute the same code against multiple PHP versions simultaneously.
  - Move the execution controls (e.g., Run button, PHP version selector) from the "Code Editor" panel into a dedicated "PHP" panel.
  - Enable users to add multiple PHP version rows (via a plus button), where each row provides its own "Run" button and PHP version selector.
  - Each row displays its own separate "Output" panel, showing the result for the selected PHP version.
  - Optionally, provide a "Run All" button to execute the code across all configured PHP versions at once.
  - Useful for comparing output, performance, or compatibility between PHP versions.
- [ ] "Diff Output of Multi Version Run" (requires "Multi Version Run")
  - After running the same code across multiple PHP versions, provide a way to visually compare (diff) the outputs.
  - Highlight differences between the outputs of each PHP version in a side-by-side or unified diff view.
  - Useful for quickly spotting behavioral or output changes between PHP versions.
  - Optionally, allow users to select which versions to compare.
- [ ] Store the PHP WASM modules compressed (either gz or brotli)
  - Compress each WASM module as part of the build or release workflow (e.g., produce both `.wasm.gz` and `.wasm.br` files).
  - Serve the pre-compressed files directly, letting the server set the correct `Content-Encoding` header based on the client's `Accept-Encoding` request.
  - This avoids on-the-fly compression, reduces server CPU usage, and speeds up downloads for users.
  - Update the module index (e.g., `PHP-WASM-Modules-Index.json`) to include links and checksums for each compression format.
  - Ensure the playground loader can fetch and decompress the modules in the browser if needed (most browsers support gzipped WASM natively).
  - Optionally, provide a fallback to the uncompressed `.wasm` if the client does not support compression.
- [ ] Find a way to not store the PHP WASM modules in the git repository (avoid repo bloat)
  - the wasm modules are large (3,5MB+) and only grow, if more extensions are enabled
  - also the number is multiplied by the supported PHP version range
  - maybe store them as Github Releases and use a workflow to build a "PHP-WASM-Modules-Index.json"
  - The playground fetches this index at runtime to display available PHP versions
  - As gh-pages has a pre-deploy step, we can transfer all or "a requested" PHP WASM module
  - Optionally, support fallback mirrors (e.g., Cloudflare R2, S3, jsDelivr) for redundancy and faster downloads.
- [ ] Open in another playground (transfer code to another playground)
- [ ] Document settings:
  - [ ] Max execution time
    Example:

    ```php
    <?php
    while (true) {
        echo(1);
    }
    ```

- [ ] automatic code formatting using tidy extension?
- [ ] persistent editor state:
  - Save the editor content and settings (PHP version, output mode, etc.) in localStorage
  - so users can resume where they left off?
- [ ] inline documentation / code guidance by hovering
  - Show PHP function signatures and documentation tooltips in the editor
  - using Monaco’s hover provider or similar?
- [ ] Show more detailed performance metrics (e.g., memory usage)

## Todo

- [ ] add "Performance" tab
  - for each version display: version, system time, user time, memory
- [ ] provide "opcodes" tab to see the instruction in the PHP VM
  - [ ] compile "vulcan logic dumper" php extension into the wasm module
  - [ ] compiling seems uncomplicated, but activating the extension is not possible during runtime, because one can't set PHP_SYSTEM_INI directives. this needs to be done on the outside env.
  so, i assume seems these INI settings have to be set and compiled into the php-wasm-bridge.c?
  - [ ] or ship a php.ini with the wasm module and bake it in (together with other asset files)
- [ ] allow usage of `declare(strict_types=1);` on the first line
  - `<?php declare(strict_types=1);` will trigger
  - `Fatal error: strict_types declaration must be the very first statement in the script in script on line 1`
  - which implies that the php-wasm module adds an internal first line to the executed php content?

## Will-not-implement

- [ ] multi-file support: Allow users to create and manage multiple PHP files/tabs in the playground? (won't implement)
- [ ] URL sharing feature:
  - Shareable code links: Generate a shareable URL with the current code and settings (using URL encoding or a paste service)?
  - [ ] **Won't implement** due to storage concerns
  - [ ] **Unresolved:** Where to store shared code? Possibly use another playground or code paste service
  - [ ] **Too much work:** Need content moderation to prevent abuse
- [ ] "Create Issue" directly against PHP Issue Tracker with the not working example included
  - Allow users to quickly report bugs or incompatibilities by creating a pre-filled issue on the official PHP Issue Tracker.
  - Automatically include the current code example, PHP version, and output/error in the issue template.
  - This feature depends on the URL sharing capability, since the code and settings must be reproducible by others.
  - Even if the code is embedded in the issue, a shareable link helps maintain context and enables easy reproduction.
  - Consider privacy and security: warn users that their code and output will be publicly
- [ ] Automatic insertion of opening PHP tag:
  - [ ] If the user forgets to add `<?php`, prepend it automatically
  - [ ] When the user clears the editor, add `<?php` automatically on line 1
  - [ ] **Solved**: Reset Button always inserts a working hello world example to start from

## In-Progress

- [ ] Editor: Run code using multiple PHP-WASM modules
- [ ] Builder: compile multiple PHP-WASM modules
  - [ ] use PHP version as DOCKER argument
- [ ] support only "Currently Supported Version" of PHP
  - https://www.php.net/supported-versions.php
  - grab this via json? or hardcode the matrix?

## Features (Done)

- [x] CSS based on Bootstrap 5
- [x] Editor Panel and Output Panel and Error Panel
- [x] Support for multiple editors:
  - [x] CodeMirror 5
    - [ ] Syntax highlighting for PHP (is this even possible? wtf)
  - [x] Monaco
    - [x] Syntax highlighting for PHP
- [x] Toggle button for output mode (raw vs. HTML output, e.g., `phpinfo()`)
- [x] Provide two code execution modes:
  - [x] "Continuous" mode: Live code output preview as you type
  - [x] "Single run" mode: User must click "Run" to execute the code
  - [ ] if the "Continous Checkbox" is on, hide the run button, else show run button (not needed)
- [x] Reset functionality:
  - [x] Clears the editor to a basic Hello World example
  - [ ] ask user for confirmation via dialog box?
- [x] Add multiple PHP-WASM modules
- [x] PHP version selection via dropdown
- [x] Performance display
- [x] Add link to the repository for issues (bug reports & feature requests)
- [x] Dropdown for selecting example code snippets to prefill the editor
  - [x] Add some examples, e.g. `playground/examples/hello_world.php`
  - [x] set content mode HTML for phpinfo example automatically, raw for all others
- [x] Save button to save editor content as a PHP file
- [x] Publish playground on Github Pages: https://jakoch.github.io/php-wasm-devbox/
- [x] Status bar: display Ln:x, Col:y of the cursor and content size in bytes at the bottom of the editor
- [x] display the "auto run" interval, with run button flash exec indication on the UI; auto_run_interval is a constant.
- [x] Status bar font size controls: decrease/increase font size of editor (small/big A icons) and keyboard shortcuts Ctrl + "+" and Ctrl + "-"
- [x] added a "PHP Function Reference" panel underneath the "Code Editor" panel to list the PHP functions used with a link to the php manual
- [x] Further accessibility improvements (ARIA, tab order, screen reader)
  - [x] Improved ARIA roles, labels, and regions for accessibility
  - [x] Improved tab order and keyboard accessibility for all interactive elements
  - [x] Updated help section
- [x] Highlight PHP syntax and parse errors directly in the code editor
- [x] Avoid reloading the WASM module in case auto-run interval is active

