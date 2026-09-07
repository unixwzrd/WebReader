import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@mozilla/readability/Readability.js");
const destination = resolve(root, "extension/vendor/Readability.js");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Copied ${source} to ${destination}`);
