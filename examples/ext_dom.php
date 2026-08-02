<?php

// declare(strict_types=1);

/**
 * This script demonstrates how to use the DOM extension in PHP to work with HTML documents.
 *
 * Functions used: DOMDocument, loadHtml, getElementById, nodeValue, assert, class_exists
 */

// First, we need to check if the DOM extension is loaded
assert(class_exists('\DOMDocument'));

// Then we create a new DOMDocument instance and load a simple HTML string into it.
$doc = new DOMDocument();
$doc->loadHtml('<html><head><meta charset="UTF-8"></head><body id="app">Hello</body></html>');

// Now we check the HTML element with the id "app" in the document for its content.
assert($doc->getElementById('app')->nodeValue === 'Hello');

// Finally, we can output the content of the element
var_dump($doc->getElementById('app')->nodeValue);
