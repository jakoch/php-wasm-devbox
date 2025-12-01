<?php

/**
 * This script demonstrates how to format array output nicely by finding the
 * longest key of an array and aligning all values accordingly.
 * It's particularly useful for displaying arrays in a readable format
 * where keys vary in length.
 *
 * Functions used: array_keys, array_reduce, strlen, str_pad
 */

// Create a test array with various data types and keys of different lengths
$array = [
    "1" => "jakoch's PHP WASM Playground",
    "emoji" => "😀 😃 😄 😁 😆",
    42,                    // Numeric key
    10 => 1234,           // Another numeric key-value pair
    "Random number" => rand(100,999)  // Key with spaces and random value
];

/**
 * Function to compare strings and return the longer one
 * @param string|null $carry The longest string found so far (initial value is 1)
 * @param string $item Current string being compared
 * @return string The longer of the two strings
 */
function filter_by_length($carry, $item) {
    if (strlen($item) > strlen($carry)) {
        return $item;
    }
    return $carry;
}

// Find the length of the longest key using array_reduce
// array_reduce takes an array, a comparison function and an initial value
// it will compare each element of the array with the initial value and return the longest one.
// Then it will compare the longest one with the next element and so on,
// until all elements are compared and the longest one is returned.
// Finally, we can apply strlen to get the length of the longest key.
$longestKey = strlen(array_reduce(
    array_keys($array),      // Get all keys from the array
    'filter_by_length',      // Here we use our comparison function from above
    1                        // Initial value for comparison
));

// Format and display each key-value pair with proper alignment
// 1. Pad the key with spaces until it reaches the longest key length
// 2. concatenate the string using seperator " => "
// 3. Pad the value with spaces from the left until it reaches 30 characters
foreach ($array as $key => $value) {
    echo str_pad($key, $longestKey)  . " => "   . str_pad($value, 30, " ", STR_PAD_LEFT) . "\n";
}
