/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Playwright configuration for the playground (WP-06).
 *
 * `npm run test:e2e` starts tests/server.mjs itself, so nothing has to be
 * running first. See tests/server.mjs for why it is not ./serve.sh.
 *
 * Only *.spec.js files are collected: the plain-Node unit tests live in
 * tests/unit/ as *.test.mjs and are run by `npm run test:unit` (`node --test`),
 * which is a different runner with different globals.
 */

import { defineConfig, devices } from 'playwright/test';

const HOST = process.env.PLAYGROUND_HOST || '127.0.0.1';
const PORT = process.env.PLAYGROUND_PORT || 8000;
const baseURL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',

  // The WASM module is ~3.5 MB and gets compiled per browser context, so the
  // suite is dominated by module loading. A generous per-test timeout keeps a
  // cold first run from failing on the download rather than on the assertion.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Each worker holds a browser plus a PHP runtime. Two at a time is enough to
  // catch real concurrency bugs without turning the run into a memory test.
  workers: process.env.CI ? 1 : 2,

  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL,
    // Kept for a failed run only: the page is a WASM app, and the console plus
    // the network log are usually what explains the failure.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `node tests/server.mjs`,
    url: `${baseURL}/index.html`,
    // Reuse a server a developer already started; never on CI, where a stale
    // one on the port would silently test the wrong tree.
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PLAYGROUND_HOST: HOST, PLAYGROUND_PORT: String(PORT) }
  }
});