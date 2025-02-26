### Issues for PHP-WASM Playground

## Features

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
  - [x] Clear the editor (ask user for confirmation via dialog box)
- [x] Add multiple PHP-WASM modules
- [x] PHP version selection via dropdown
- [x] Performance display
- [x] Add link to the repository for issues (bug reports & feature requests)
- [ ] Automatic insertion of opening PHP tag:
  - [ ] If the user forgets to add `<?php`, prepend it automatically
  - [ ] When the user clears the editor, add `<?php` automatically on line 1
- [ ] Document settings:
  - [ ] Max execution time
    Example:
    ```php
    <?php
    while (true) {
        echo(1);
    }
    ```
- [ ] Dropdown for selecting example code snippets to prefill the editor
- [x] Save button to save editor content as a PHP file
- [ ] URL sharing feature (Not Implementing):
  - [ ] **Won't implement** due to storage concerns
  - [ ] **Unresolved:** Where to store shared code? Possibly use another playground or code paste service
  - [ ] **Too much work:** Need content moderation to prevent abuse

