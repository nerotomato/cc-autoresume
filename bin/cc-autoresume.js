#!/usr/bin/env node

const { main } = require('../dist/index.js');

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[cc-autoresume] ${message}`);
  process.exitCode = 1;
});
