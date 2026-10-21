<?php

// This algorithm converts a binary number (represented as an array of 0s and 1s) into its decimal equivalent.
// Specifically, this example converts the binary number 1011 to decimal 11.

$binary = array(1, 0, 1, 1);
$decimal = 0;
$power_of_2 = 1;
$n = count($binary);
$i = $n - 1;

while ($i >= 0) {
  $decimal = $decimal + $binary[$i] * $power_of_2;
  $power_of_2 = $power_of_2 * 2;
  $i = $i - 1;
}

assert($decimal === 11);

echo "The decimal number is: $decimal\n";

// or simply using PHP's built-in function bindec

echo "The decimal number is: " . bindec('1011') . "\n";
