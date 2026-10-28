const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { recognize } = require('./recognize');
const { extractImageText } = require('./ocr');
const run = promisify(execFile);
let pdfModule;
async function extractText(file) {
  file = path.resolve(file);
  const extension = path.extname(file).toLowerCase();
  if (extension === '.pdf') {
    pdfModule ||= import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjs = await pdfModule;
    const document = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, isEvalSupported: false }).promise;
    try {
      const pages = [];
      for (let n = 1; n <= Math.min(document.numPages, 8); n++) {
        const page = await document.getPage(n);
        const content = await page.getTextContent();
        // PDF text streams often list column labels before all their values.
        // Rebuild visual lines so the payable total stays next to its label.
        const lines = [];
        for (const item of content.items.filter(item => item.str)) {
          const y = item.transform[5];
          let line = lines.find(line => Math.abs(line.y - y) < 3);
          if (!line) { line = { y, items: [] }; lines.push(line); }
          line.items.push(item);
        }
        pages.push(lines.sort((a, b) => b.y - a.y).map(line => line.items.sort((a, b) => a.transform[4] - b.transform[4]).map(item => item.str).join(' ')).join('\n'));
      }
      return pages.join('\n');
    } finally { await document.destroy(); }
  }
  if (['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff'].includes(extension)) {
    return extractImageText(file);
  }
  return '';
}
async function analyze(file) {
  const name = path.basename(file);
  const quick = recognize(name);
  let text = '', error = '';
  if (!quick.amountCents || !quick.category || (path.extname(file).toLowerCase() === '.pdf' && (!quick.documentType || quick.category === '高铁'))) {
    try { text = await extractText(file); }
    catch { error = '此文件未能自动读取，可手动填写类别和金额'; }
  }
  let result = recognize(name, text);
  if (path.extname(file).toLowerCase() === '.pdf' && result.category === '高铁' && !result.route) {
    const temporaryFiles = [];
    try {
      const pdfjs = await (pdfModule ||= import('pdfjs-dist/legacy/build/pdf.mjs'));
      const { createCanvas } = require('@napi-rs/canvas');
      const document = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, isEvalSupported: false }).promise;
      try {
        const page = await document.getPage(1), viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const temporary = path.join(os.tmpdir(), `shizhang-ticket-${process.pid}-${Date.now()}-canvas.png`);
        temporaryFiles.push(temporary);
        await fs.writeFile(temporary, canvas.toBuffer('image/png'));
        const ocrText = await extractText(temporary);
        text += '\n' + ocrText;
        result = recognize(name, text);
      } finally { await document.destroy(); }
    } catch { /* The editable route field remains available when a scanned ticket cannot be read. */ }
    if (!result.route) {
      try {
        const prefix = path.join(os.tmpdir(), `shizhang-ticket-${process.pid}-${Date.now()}-native`);
        const image = prefix + '.png'; temporaryFiles.push(image);
        await run(process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', file, prefix], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
        text += '\n' + await extractText(image);
        result = recognize(name, text);
      } catch { /* Some computers do not have a native PDF renderer; users can fill the route manually. */ }
    }
    for (const temporary of temporaryFiles) await fs.unlink(temporary).catch(() => {});
  }
  return { path: file, name, extension: path.extname(file), ...result, note: error || result.note, excerpt: text.slice(0, 1800) };
}
module.exports = { analyze, extractText };
