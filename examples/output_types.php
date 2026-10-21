<?php

// This example demonstrates how to write to standard output and standard error
// and return a value from a PHP script.

// In PHP, only single expressions can return strings.
// To execute multiple commands and return a value, wrap the commands in
// an immediately invoked function expression (IIFE).
// This pattern is common in JavaScript but less so in PHP.

(function() {
	global $persist;

	fwrite(fopen('php://stdout', 'w'), "standard output!" . PHP_EOL);
	fwrite(fopen('php://stdout', 'w'), sprintf(
		"Ran %d times!\n", ++$persist
	));
	fwrite(fopen('php://stderr', 'w'), 'standard error!' . PHP_EOL);

	return 'return value';
})();
