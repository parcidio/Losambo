// Converte um artboard .dc.html do Claude Design numa página HTML simples.
// Uso: node scripts/convert-design.mjs <entrada.dc.html> <saida.html> [accent]
import { readFileSync, writeFileSync } from 'node:fs';
const [, , input, output, accent = '#F6821F'] = process.argv;
const src = readFileSync(input, 'utf8');
const title = src.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'Losambo';
const helmet = src.match(/<helmet>([\s\S]*?)<\/helmet>/)?.[1] ?? '';
const body = src.match(/<\/helmet>([\s\S]*?)<\/x-dc>/)?.[1] ?? '';
const html = `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
${helmet.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`.replaceAll('{{accent}}', accent);
writeFileSync(output, html);
console.log(`${input} -> ${output}`);
