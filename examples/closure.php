<?php

/**
 * This script demonstrates how to use closures in PHP.
 * A closure is an anonymous function that can be used as a callback.
 * In this example, we will create a closure that doubles a number
 * and then use it with an array of numbers.
 *
 * Functions used: array_map
 */

// Define a closure that doubles a number
// A closure is defined using the 'function' keyword without a name
// It can capture variables from the surrounding scope, if needed
// In this case, it takes one parameter $a and returns $a multiplied by 2
// The closure can be assigned to a variable, which can then be used as a callback.
$double = function($a) {
    return $a * 2;
};

// This is an array of numbers from 1 to 5
// We will use array_map to apply the closure to each element in the array
$numbers = range(1, 5);

// array_map takes a callback function (type callable) and an array.
// It applies the callback to each element and returns a new array with the results
// In this case, it will double each number in the array
// The result will be an array of doubled numbers
$new_numbers = array_map($double, $numbers);

assert(is_array($new_numbers));
assert(count($new_numbers) === 5);
assert($new_numbers === [2, 4, 6, 8, 10]);

print implode(' ', $new_numbers);
