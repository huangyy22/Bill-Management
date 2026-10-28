const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { Store, inside, PRINT_EXPORTS } = require('./lib/store');
const { analyze } = require('./lib/extract');
const { CATEGORIES } = require('./lib/recognize');
const { exportPrintFolder } = require('./lib/export-print');

let window, store, configPath;
const allowedSources = new Set();
const testMode = process.env.SHIZHANG_TEST === '1';
const testRoot = process.env.SHIZHANG_TEST_ROOT;
if (testMode) app.setPath('userData', path.join(testRoot, '.test-profile'));

async function readConfig() {
  try { return JSON.parse(await fs.readFile(configPath, 'utf8')); } catch { return {}; }
}
async function writeConfig(config) {
  const temp = configPath + '.tmp';
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(temp, configPath);
}
async function pickFolder(title, defaultPath) {
  const result = await dialog.showOpenDialog({ title, defaultPath, buttonLabel: '使用此文件夹', properties: ['openDirectory'] });
  return result.canceled || !result.filePaths[0] ? '' : path.resolve(result.filePaths[0]);
}
async function resolveRoot() {
  if (testMode) return testRoot;
  const config = await readConfig();
  if (config.root) {
    const stat = await fs.stat(config.root).catch(() => null);
    if (stat?.isDirectory()) return path.resolve(config.root);
  }
  const selected = await pickFolder('首次使用：选择报销文件夹', app.getPath('documents'));
  if (selected) return selected;
  await dialog.showMessageBox({ type: 'info', title: '拾账', message: '需要选择一个报销文件夹才能开始使用。', buttons: ['退出'] });
  app.quit();
  return '';
}

const singleton = app.requestSingleInstanceLock();
if (!singleton) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      configPath = path.join(app.getPath('userData'), 'config.json');
      const root = await resolveRoot();
      if (!root) return;
      store = new Store(root);
      await store.init();
      if (!testMode) await writeConfig({ ...(await readConfig()), root: store.root });
      if (process.platform === 'win32') execFile('attrib.exe', ['+H', store.meta], { windowsHide: true }, () => {});
      window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1080, minHeight: 720, title: '拾账 · 报销管理', icon: path.join(__dirname, 'assets', 'icon.png'), backgroundColor: '#f6f7fa', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadFile(path.join(__dirname, 'ui', 'index.html'));
    } catch (error) { dialog.showErrorBox('拾账启动失败', error.message); app.quit(); }
  });
}
app.on('window-all-closed', () => app.quit());

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents) throw new Error('Invalid sender');
    try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error: error.message }; }
  });
}
handle('snapshot', () => store.snapshot());
handle('categories', () => CATEGORIES);
handle('change-root', async () => {
  if (store.busy) throw new Error('正在处理上一项操作，请稍后再试');
  const selected = await pickFolder('选择报销文件夹', path.dirname(store.root));
  if (!selected || selected === store.root) return null;
  if (inside(store.root, selected)) throw new Error('请选择当前报销文件夹以外的文件夹');
  const candidate = new Store(selected);
  await candidate.init();
  await writeConfig({ ...(await readConfig()), root: candidate.root });
  allowedSources.clear();
  store = candidate;
  if (process.platform === 'win32') execFile('attrib.exe', ['+H', store.meta], { windowsHide: true }, () => {});
  return store.snapshot();
});
handle('pick-files', async () => {
  const result = await dialog.showOpenDialog(window, { title: '选择需要归档的报销凭证', properties: ['openFile', 'multiSelections'] });
  return result.canceled ? [] : result.filePaths;
});
handle('analyze', async paths => {
  if (!Array.isArray(paths) || paths.length > 200) throw new Error('每次最多导入 200 个文件');
  const results = [];
  for (const file of paths) {
    const absolute = path.resolve(file);
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请拖入文件，暂不支持整个文件夹');
      if (inside(store.root, absolute)) throw new Error('此文件已在报销目录内，无需再次导入');
      allowedSources.add(absolute);
      const row = await analyze(absolute);
      results.push(row);
      window.webContents.send('analysis-progress', { done: results.length, total: paths.length, row });
    } catch (error) {
      const row = { path: absolute, name: path.basename(absolute), error: error.message };
      results.push(row);
      window.webContents.send('analysis-progress', { done: results.length, total: paths.length, row });
    }
  }
  return results;
});
handle('import', async options => {
  if (!options.rows?.every(row => allowedSources.has(path.resolve(row.path)))) throw new Error('请先选择或拖入文件');
  return store.importFiles(options);
});
handle('create-project', name => store.createProject(name));
handle('rename', (relative, name) => store.renameEntry(relative, name));
handle('status', (relative, complete) => store.markStatus(relative, complete));
handle('undo', id => store.undo(id));
handle('open', async (relative, reveal = false) => {
  const file = path.resolve(store.root, relative || '');
  if (!inside(store.root, file) || inside(store.meta, file)) throw new Error('路径超出报销目录');
  if (!inside(await fs.realpath(store.root), await fs.realpath(file))) throw new Error('文件链接指向报销目录外');
  if (reveal) { shell.showItemInFolder(file); return; }
  const stat = await fs.stat(file);
  if (!stat.isDirectory() && !['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.docx', '.xlsx', '.doc', '.xls', '.txt', '.zip', '.rar', '.7z'].includes(path.extname(file).toLowerCase())) throw new Error('请在文件管理器中打开此类型文件');
  const error = await shell.openPath(file); if (error) throw new Error(error);
});
handle('preview', async file => {
  const absolute = path.resolve(file);
  const real = await fs.realpath(absolute);
  if (!allowedSources.has(absolute) && (!inside(store.root, real) || inside(store.meta, real))) throw new Error('不允许预览此文件');
  const ext = path.extname(absolute).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.pdf': 'application/pdf' }[ext];
  if (!mime) return null;
  if ((await fs.stat(absolute)).size > 30 * 1024 * 1024) throw new Error('文件较大，请在文件管理器中预览');
  return { mime, data: (await fs.readFile(absolute)).toString('base64') };
});
handle('export', async relative => {
  const snapshot = await store.snapshot();
  const all = [...snapshot.active, ...snapshot.completed];
  let project;
  function find(nodes) { for (const n of nodes) { if (n.relative === relative) project = n; else if (n.isDirectory) find(n.children); } }
  find(all);
  if (!project) throw new Error('请选择报销项目');
  const output = await dialog.showSaveDialog(window, { title: '导出报销清单', defaultPath: `${project.name}-报销清单.csv`, filters: [{ name: 'CSV 表格', extensions: ['csv'] }] });
  if (output.canceled) return false;
  const cell = value => { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
  const rows = [['名称', '类别', '金额（元）', '说明', '路径']];
  function walk(nodes) { for (const n of nodes) {
    if (n.duplicateArchive) continue;
    if (n.ownAmount !== null) rows.push([n.name, n.category, (n.amountCents / 100).toFixed(2), n.isDirectory ? '文件夹标注金额；内部附件不重复计入' : '', n.relative]);
    else if (n.isDirectory) walk(n.children);
    else rows.push([n.name, n.category, '', '未标注金额', n.relative]);
  } }
  walk(project.children);
  const detailTotal = rows.slice(1).reduce((sum, row) => sum + Math.round(Number(row[2] || 0) * 100), 0);
  if (project.ownAmount !== null && detailTotal !== project.amountCents) rows.push(['明细合计', '', (detailTotal / 100).toFixed(2), '与项目文件夹标注不同，请核对', '']);
  rows.push(['项目总额', '', (project.amountCents / 100).toFixed(2), project.ownAmount !== null ? '按项目文件夹标注' : '按可识别明细汇总', '']);
  await fs.writeFile(output.filePath, '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n'), 'utf8');
  return true;
});
handle('export-print', async relative => {
  const source = await store.validateDirectory(relative);
  const archivedRoot = path.join(store.root, '已报销');
  if (![store.root, archivedRoot].includes(path.dirname(source))) throw new Error('请在项目首页导出打印文件夹');
  const snapshot = await store.snapshot();
  const project = [...snapshot.active, ...snapshot.completed].find(item => item.relative === relative);
  if (!project) throw new Error('未找到报销项目');
  const output = path.join(store.root, PRINT_EXPORTS);
  await fs.mkdir(output, { recursive: true });
  const result = await exportPrintFolder(source, output, project.name, project.amountCents);
  await shell.openPath(result.destination);
  return result;
});
