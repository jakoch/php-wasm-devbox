<?php

// This example shows how to convert PHP data to and from JSON.

$x = [
    "id" => 1,
    "name" => "Example",
    "is_active" => true,
    "balance" => 1234,
    "currency" => "BTC",
    "created_at" => "2023-10-01T12:34:56Z",
    "tags" => ["php", "json", "example"],
    "metadata" => [
        "ip_address" => "192.168.1.1",
        "user_agent" => "Datazilla/1.0"
    ]
];

$json = json_encode($x, JSON_PRETTY_PRINT);

var_dump($json);

$decoded_json = json_decode($json, true)

var_dump($decoded_json);
