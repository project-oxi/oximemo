#!/usr/bin/env node
import { main } from "./command.mjs";

try {
  main();
} catch (error) {
  console.error(`garden: ${error.message}`);
  process.exitCode = 1;
}
