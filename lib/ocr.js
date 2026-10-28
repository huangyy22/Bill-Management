const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { wordsToText, supplementAmounts } = require('./ocr-layout');
const { recognize } = require('./recognize');
const run = promisify(execFile);

const LANGUAGE_PREFERENCE = ['chi_sim', 'chi_tra', 'eng'];
const unpackedPath = file => file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

async function fileExists(file) { return fs.access(file).then(() => true, () => false); }
async function copyOnce(source, target) {
  if (await fileExists(target)) return;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    if (!(await fileExists(target))) throw error;
  }
}

// Windows ships a system OCR engine, so keep using it there. Other platforms
// use a system Tesseract when installed, otherwise the bundled offline engine.
async function windowsWords(file) {
  const script = __dirname.includes('app.asar') ? path.join(process.resourcesPath, 'ocr.ps1') : path.join(__dirname, 'ocr.ps1');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ImagePath', file], { windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(result.stdout);
}

let systemOcrPromise;
function systemOcr() {
  systemOcrPromise ||= (async () => {
    if (process.platform === 'win32') return null;
    try {
      const result = await run('tesseract', ['--list-langs'], { timeout: 15000, maxBuffer: 1024 * 1024 });
      const output = `${result.stdout}\n${result.stderr}`;
      const installed = new Set(output.split(/\r?\n/).map(line => line.trim()));
      const wanted = LANGUAGE_PREFERENCE.filter(language => installed.has(language));
      // English-only Tesseract would lose the Chinese labels on receipts, so
      // prefer the bundled Chinese data unless the system has Chinese too.
      return wanted.some(language => language.startsWith('chi_')) ? wanted.join('+') : null;
    } catch { return null; }
  })();
  return systemOcrPromise;
}

async function tesseractCliWords(file, languages) {
  const result = await run('tesseract', [file, 'stdout', '-l', languages, 'tsv'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  const words = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const columns = line.split('\t');
    if (columns[0] !== '5' || columns.length < 12) continue;
    const text = columns.slice(11).join('\t').trim();
    if (!text) continue;
    const [x, y, width, height, confidence] = columns.slice(6, 11).map(Number);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    words.push({ text, x, y, width, height, confidence });
  }
  return words;
}

let bundledPromise;
function bundledEngine() {
  bundledPromise ||= (async () => {
    const packs = [];
    for (const name of ['@tesseract.js-data/chi_sim', '@tesseract.js-data/eng']) {
      try { packs.push({ name, ...require(name) }); } catch { /* optional language data */ }
    }
    if (!packs.length) throw new Error('缺少离线 OCR 语言数据');
    let langPath = packs[0].langPath, langs = packs[0].code;
    if (packs.length > 1) {
      // tesseract.js expects every language file to live in the same folder.
      const directory = path.join(os.tmpdir(), 'shizhang-tessdata-1');
      await fs.mkdir(directory, { recursive: true });
      for (const pack of packs) {
        const source = path.join(unpackedPath(pack.langPath), `${pack.code}.traineddata${pack.gzip ? '.gz' : ''}`);
        await copyOnce(source, path.join(directory, path.basename(source)));
      }
      langPath = directory; langs = packs.map(pack => pack.code).join('+');
    }
    return {
      langs,
      langPath: langPath.startsWith(os.tmpdir()) ? langPath : unpackedPath(langPath),
      workerPath: unpackedPath(require.resolve('tesseract.js/src/worker-script/node/index.js'))
    };
  })();
  return bundledPromise;
}

async function bundledWords(file) {
  const engine = await bundledEngine();
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker(engine.langs, 1, {
    langPath: engine.langPath, workerPath: engine.workerPath, cacheMethod: 'none', errorHandler: () => {}
  });
  try {
    const { data } = await worker.recognize(await fs.readFile(file), {}, { blocks: true });
    return (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words))).map(word => ({
      text: word.text, confidence: word.confidence,
      x: word.bbox.x0, y: word.bbox.y0, width: word.bbox.x1 - word.bbox.x0, height: word.bbox.y1 - word.bbox.y0
    }));
  } finally { await worker.terminate(); }
}

async function extractImageText(file) {
  if (process.platform === 'win32') {
    let words = [];
    try { words = await windowsWords(file); } catch { /* fall through to bundled engine */ }
    const text = wordsToText(words);
    if (recognize(path.basename(file), text).amountCents && !/交\s*易\s*金\s*额|记\s*账\s*金\s*额/.test(text)) return text;
    // A bundled local engine handles numeric fonts Windows OCR skips.
    try { return wordsToText(supplementAmounts(words, await bundledWords(file))); } catch { return text; }
  }
  const languages = await systemOcr();
  if (languages) {
    try {
      const words = await tesseractCliWords(file, languages);
      if (words.length) return wordsToText(words);
    } catch { /* fall through to bundled engine */ }
  }
  try { return wordsToText(await bundledWords(file)); } catch { return ''; }
}

module.exports = { extractImageText };
