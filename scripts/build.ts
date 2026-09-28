import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await Bun.$`./node_modules/.bin/tsc -p tsconfig.build.json --emitDeclarationOnly`;
await Bun.$`bun build ./src/index.ts --target=node --packages=external --minify --outfile=dist/index.js`;
