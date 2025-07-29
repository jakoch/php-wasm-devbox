# Issues for PHP-WASM Playground

## Backlog (Ideas)

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
- [ ] display Ln:x, Col: y of the cursor in a status bar at the bottom
- [ ] display Content size in bytes in status bar
- [ ] allow to decrease/increased font size of editor (small t, big T icons)
- [ ] persistent editor state:
  - Save the editor content and settings (PHP version, output mode, etc.) in localStorage
  - so users can resume where they left off?
- [ ] inline documentation
  - Show PHP function signatures and documentation tooltips in the editor
  - using Monaco’s hover provider or similar?
- [ ] accessibility improvements: Ensure the playground is usable with screen readers and keyboard navigation.
- [ ] display the "auto run" interval and last exec time, maybe with "flashing dot" exec indication?

## Todo

- [ ] add "Performance" tab
  - for each version display: version, system time, user time, memory
- [ ] provide "opcodes" tab to see the instruction in the PHP VM
  - [ ] compile "vulcan logic dumper" php extension into the wasm module
- [ ] provide "docs" tab to list the php functions used with a link to the php manual
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
