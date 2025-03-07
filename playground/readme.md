# Issues for PHP-WASM Playground

## Backlog (Ideas)

- [ ] Open in another playground (transfer code to another playground)
- [ ] URL sharing feature:
  - [ ] **Won't implement** due to storage concerns
  - [ ] **Unresolved:** Where to store shared code? Possibly use another playground or code paste service
  - [ ] **Too much work:** Need content moderation to prevent abuse
- [ ] Document settings:
  - [ ] Max execution time
    Example:

    ```php
    <?php
    while (true) {
        echo(1);
    }
    ```

- [ ] Automatic insertion of opening PHP tag:
  - [ ] If the user forgets to add `<?php`, prepend it automatically
  - [ ] When the user clears the editor, add `<?php` automatically on line 1

## Todo

- [ ] add "Performance" tab
  - for each version display: version, system time, user time, memory
- [ ] provide "opcodes" tab to see the instruction in the PHP VM
  - [ ] compile "vulcan logic dumper" php extension into the wasm module
- [ ] provide "docs" tab to list the php functions used with a link to the php manual

## In-Progress

- [ ] Run code using multiple PHP-WASM modules
  - [ ] compile multiple PHP-WASM modules
  - [ ] use PHP version as DOCKER argument
  - [ ] support only "Currently Supported Version" of PHP, https://www.php.net/supported-versions.php
    - grab this via json? or hardcode the matrix?

## Features (Done)

- [x] CSS based on Bootstrap 5
- [x] Editor Panel and Output Panel
- [x] Support for multiple editors:
  - [x] CodeMirror 5
    - [ ] Syntax highlighting for PHP (is this even possible? wtf)
  - [x] Monaco
    - [x] Syntax highlighting for PHP
- [x] Toggle button for output mode (raw vs. HTML output, e.g., `phpinfo()`)
- [ ] Provide two code execution modes:
  - [ ] "Continuous" mode: Live code output preview as you type
  - [x] "Single run" mode: User must click "Run" to execute the code
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
