#!/usr/bin/env node
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
register(pathToFileURL(join(root, "runtime", "gentle-pi-models-loader.mjs")).href, import.meta.url);
const { runStdin } = await import(pathToFileURL(join(root, "runtime", "gentle-pi-models.ts")).href);
runStdin();
