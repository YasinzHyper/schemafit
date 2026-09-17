#!/usr/bin/env node
import { text } from "node:stream/consumers";
import { run } from "./cli.js";

const color =
  process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0"
    ? true
    : process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

process.exitCode = await run(process.argv.slice(2), {
  stdout: (output) => process.stdout.write(output),
  stderr: (output) => process.stderr.write(output),
  readStdin: () => text(process.stdin),
  color,
});
