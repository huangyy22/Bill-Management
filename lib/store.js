const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { amountFromName, amountLabel, categoryFromText, toCents } = require('./recognize');
const { DOCUMENT_TYPES, documentTypeFromText, categoryLabel, cleanRoute, fileName, numberedName } = require('./naming');
const { applyCompleteness } = require('./completeness');

const ARCHIVES = new Set(['.zip', '.rar', '.7z']);
const PRINT_EXPORTS = '导出打印';
function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function safeName(value) {
  const result = String(value || '').trim();
  if (!result || result.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(result) || /[. ]$/.test(result) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) || result === '.' || result === '..') throw new Error('名称不能为空，且不能包含 Windows 不支持的字符');
  return result;
}
async function exists(file) { try { await fsp.access(file); return true; } catch { return false; } }
async function fingerprint(file) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function moveNoReplace(source, destination) {
  // Exclusive copy works across disks, with read-only invoices, and never overwrites another file.
  const originalMode = (await fsp.stat(source)).mode;
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  let changedReadOnly = false;
  try {
    if (await fingerprint(source) !== await fingerprint(destination)) throw new Error('复制校验失败，原文件已保留');
    try { await fsp.unlink(source); }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM' || originalMode & 0o200) throw error;
      await fsp.chmod(source, originalMode | 0o200);
      changedReadOnly = true;
      await fsp.unlink(source);
    }
  } catch (error) {
    if (changedReadOnly) await fsp.chmod(source, originalMode).catch(() => {});
    await fsp.chmod(destination, originalMode | 0o200).catch(() => {});
    await fsp.unlink(destination).catch(() => {});
    throw error;
  }
}

class Store {
  constructor(root) { this.root = path.resolve(root); this.meta = path.join(this.root, '.拾账'); this.statePath = path.join(this.meta, 'state.json'); this.state = { version: 1, operations: [] }; this.busy = false; }
  async init() {
    await fsp.mkdir(this.meta, { recursive: true });
    if (await exists(this.statePath)) this.state = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
    for (const op of this.state.operations) {
      if (op.status !== 'pending') continue;
      const pairs = op.moves || [];
      op.status = 'interrupted';
      for (const move of pairs) {
        const hasSource = await exists(move.source), hasDest = await exists(move.destination);
        if (!hasSource && hasDest) move.done = true;
        else if (hasSource && hasDest) {
          // A crash can leave an extra copy. Preserve both and do not guess which to remove.
          move.done = false; move.extraCopy = true;
        }
      }
    }
    await this.save();
  }
  async save() {
    const temp = this.statePath + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8');
    await fsp.rename(temp, this.statePath);
  }
  async exclusive(fn) {
    if (this.busy) throw new Error('正在处理上一项操作，请稍后再试');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async validateDirectory(relative = '', allowCompleted = true) {
    const target = path.resolve(this.root, relative);
    if (!inside(this.root, target) || inside(this.meta, target) || inside(path.join(this.root, PRINT_EXPORTS), target)) throw new Error('归档位置必须位于报销项目内');
    const real = await fsp.realpath(target);
    if (!inside(await fsp.realpath(this.root), real)) throw new Error('不能通过链接归档到报销目录外');
    if (!(await fsp.stat(real)).isDirectory()) throw new Error('目标不是文件夹');
    if (!allowCompleted && inside(path.join(this.root, '已报销'), real)) throw new Error('请选择一个正在报销的项目');
    return target;
  }
  async scanDirectory(directory, depth = 0) {
    const scanningRoot = path.resolve(directory) === this.root;
    const dirents = (await fsp.readdir(directory, { withFileTypes: true })).filter(d => !d.name.startsWith('.') && !d.isSymbolicLink() && !(scanningRoot && d.isDirectory() && d.name === PRINT_EXPORTS));
    const nodes = [];
    const folderNames = new Set(dirents.filter(d => d.isDirectory()).map(d => d.name));
    for (const dirent of dirents) {
      const absolute = path.join(directory, dirent.name);
      const stat = await fsp.stat(absolute);
      const isDirectory = dirent.isDirectory();
      const ownAmount = amountFromName(dirent.name, isDirectory);
      const children = isDirectory && depth < 16 ? await this.scanDirectory(absolute, depth + 1) : [];
      const duplicateArchive = !isDirectory && ARCHIVES.has(path.extname(dirent.name).toLowerCase()) && folderNames.has(path.parse(dirent.name).name);
      const addedAmount = isDirectory ? this.accountingAdjustments().get(absolute) || 0 : 0;
      const amountCents = duplicateArchive ? 0 : ownAmount !== null ? ownAmount + addedAmount : (isDirectory ? children.reduce((sum, n) => sum + n.amountCents, 0) : 0);
      const unknownCount = duplicateArchive || ownAmount ? 0 : isDirectory ? children.reduce((sum, n) => sum + n.unknownCount, 0) : 1;
      nodes.push({ name: dirent.name, relative: path.relative(this.root, absolute), isDirectory, amountCents, ownAmount, addedAmount, unknownCount, duplicateArchive, category: categoryFromText(dirent.name) || '其他', size: stat.size, modified: stat.mtimeMs, fileCount: isDirectory ? children.reduce((sum, n) => sum + n.fileCount, 0) : 1, children });
    }
    applyCompleteness(nodes);
    return nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || b.name.localeCompare(a.name, 'zh-CN', { numeric: true }));
  }
  accountingAdjustments() {
    const amounts = new Map();
    for (let index = 0; index < this.state.operations.length; index++) {
      const op = this.state.operations[index];
      if (op.type !== 'import' || !op.accountingDirectories || !op.moves.some(m => m.done)) continue;
      const completedMoves = op.moves.filter(move => move.done);
      const legacyAttachmentImport = op.groupAmountCents == null && op.accountingDirectories.some(directory => {
        const folderAmount = amountFromName(path.basename(directory), true);
        return path.dirname(directory) !== this.root && folderAmount !== null && completedMoves.every(move => path.dirname(move.destination) === directory && move.amountCents === folderAmount);
      });
      if (op.attachmentOnly || legacyAttachmentImport) continue;
      const cents = op.groupAmountCents || op.moves.filter(m => m.done).reduce((sum, m) => sum + m.amountCents, 0);
      for (const original of op.accountingDirectories) {
        let current = original;
        for (const later of this.state.operations.slice(index + 1)) {
          if (later.type !== 'status' || !later.moves[0].done) continue;
          const move = later.moves[0];
          if (inside(move.source, current)) current = path.join(move.destination, path.relative(move.source, current));
        }
        amounts.set(current, (amounts.get(current) || 0) + cents);
      }
    }
    return amounts;
  }
  async snapshot() {
    const top = await this.scanDirectory(this.root);
    const archived = top.find(n => n.isDirectory && n.name === '已报销');
    const active = top.filter(n => n.isDirectory && n.name !== '已报销');
    const loose = top.filter(n => !n.isDirectory);
    return { root: this.root, active, completed: archived?.children || [], loose, history: this.state.operations.slice(-30).reverse().map(op => ({ id: op.id, type: op.type, label: op.label, at: op.at, status: op.status, canUndo: ['done', 'interrupted'].includes(op.status) && op.moves?.some(m => m.done), extraCopies: op.moves?.filter(m => m.extraCopy).map(m => m.destination) || [] })) };
  }
  async createProject(name) {
    return this.exclusive(async () => {
      const destination = path.join(this.root, safeName(name));
      if (name === '已报销' || name === PRINT_EXPORTS || name.startsWith('.')) throw new Error('请换一个项目名称');
      await fsp.mkdir(destination);
      return path.relative(this.root, destination);
    });
  }
  async importFiles({ target, rows, grouped = false, groupCategory, groupAmount, groupRoute = '' }) {
    return this.exclusive(async () => {
      const destination = await this.validateDirectory(target, false);
      if (destination === this.root) throw new Error('请先选择或新建报销项目');
      if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new Error('每次请导入 1 至 200 个文件');
      const groupCents = grouped ? toCents(groupAmount) : null;
      if (grouped && !groupCents) throw new Error('请填写这笔费用的总金额');
      const destinationAmount = amountFromName(path.basename(destination), true);
      const attachmentOnly = !grouped && path.dirname(destination) !== this.root && destinationAmount !== null && rows.every(row => toCents(row.amount) === destinationAmount);
      const op = { id: crypto.randomUUID(), type: 'import', at: Date.now(), status: 'pending', label: `归档 ${rows.length} 份凭证`, moves: [], createdDirectory: null, groupAmountCents: groupCents, attachmentOnly, accountingDirectories: [] };
      if (!attachmentOnly) for (let ancestor = destination; ancestor !== this.root; ancestor = path.dirname(ancestor)) {
          if (amountFromName(path.basename(ancestor), true) !== null) op.accountingDirectories.push(ancestor);
      }
      let folder = destination;
      if (grouped) {
        const label = `${safeName(categoryLabel(groupCategory, groupRoute))}-${amountLabel(groupCents)}`;
        folder = await this.uniqueDestination(destination, label, true);
        op.createdDirectory = folder;
      }
      const reserved = new Set();
      const hashes = new Set();
      const existingHashes = new Set();
      async function collect(dir) {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await collect(file); else if (entry.isFile()) existingHashes.add(await fingerprint(file));
        }
      }
      await collect(destination);
      for (const row of rows) {
        const source = path.resolve(row.path);
        const stat = await fsp.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('仅支持普通文件，请勿拖入文件夹或快捷方式');
        if (inside(await fsp.realpath(this.root), await fsp.realpath(source))) throw new Error('此文件已经在报销目录内，请不要重复归档');
        const hash = await fingerprint(source);
        if (hashes.has(hash) || existingHashes.has(hash)) throw new Error(`发现重复凭证：${path.basename(source)}。原文件未移动。`);
        hashes.add(hash);
        const cents = grouped ? groupCents : toCents(row.amount);
        if (!cents) throw new Error(`请填写 ${path.basename(source)} 的正确金额`);
        const category = safeName(grouped ? groupCategory : row.category);
        const extension = path.extname(source);
        const documentType = row.documentType ?? documentTypeFromText(path.basename(source));
        if (documentType && !DOCUMENT_TYPES.includes(documentType)) throw new Error('请选择有效的凭证类型');
        const route = cleanRoute(grouped ? groupRoute : row.route);
        const basename = safeName(fileName(category, cents, extension, documentType, path.basename(source), grouped, route));
        const dest = await this.uniqueDestination(folder, basename, false, reserved);
        reserved.add(dest.toLowerCase());
        op.moves.push({ source, destination: dest, hash, amountCents: cents, done: false });
      }
      this.state.operations.push(op);
      await this.save();
      try {
        if (grouped) await fsp.mkdir(folder);
        for (const move of op.moves) {
          await moveNoReplace(move.source, move.destination);
          move.done = true;
          await this.save();
        }
        op.status = 'done';
        await this.save();
        return { count: rows.length, amountCents: attachmentOnly ? 0 : grouped ? groupCents : rows.reduce((sum, r) => sum + toCents(r.amount), 0), attachmentOnly };
      } catch (error) {
        // Roll back completed moves when possible; never overwrite restored source paths.
        let rollbackFailed = false;
        for (const move of op.moves.filter(m => m.done).reverse()) {
          try { await moveNoReplace(move.destination, move.source); move.done = false; } catch { rollbackFailed = true; }
        }
        if (grouped) await fsp.rmdir(folder).catch(() => {});
        op.status = rollbackFailed ? 'interrupted' : 'failed';
        await this.save();
        throw new Error(error.message + (rollbackFailed ? '。部分文件已归档，请在操作记录中查看并撤回。' : '。本次移动已回退。'));
      }
    });
  }
  async uniqueDestination(directory, name, isDirectory = false, reserved = new Set()) {
    let result = path.join(directory, name), suffix = 2;
    while (await exists(result) || reserved.has(result.toLowerCase())) result = path.join(directory, numberedName(name, suffix++, isDirectory));
    return result;
  }
  async renameEntry(relative, newName) {
    return this.exclusive(async () => {
      const source = path.resolve(this.root, relative);
      if (!inside(this.root, source) || inside(this.meta, source) || source === this.root) throw new Error('只能重命名报销目录中的凭证');
      const stat = await fsp.lstat(source);
      if ((!stat.isFile() && !stat.isDirectory()) || stat.isSymbolicLink()) throw new Error('仅支持重命名普通文件或文件夹');
      const name = safeName(newName);
      if (stat.isFile() && path.extname(name).toLowerCase() !== path.extname(source).toLowerCase()) throw new Error('请保留原文件扩展名');
      const destination = path.join(path.dirname(source), name);
      if (source.toLowerCase() === destination.toLowerCase()) return path.relative(this.root, source);
      if (await exists(destination)) throw new Error('当前文件夹已有同名文件');
      const op = { id: crypto.randomUUID(), type: 'rename', at: Date.now(), status: 'pending', label: `重命名 ${path.basename(source)}`, moves: [{ source, destination, ...(stat.isDirectory() ? { directory: true } : { hash: await fingerprint(source) }), amountCents: amountFromName(name, stat.isDirectory()) || 0, done: false }] };
      this.state.operations.push(op); await this.save();
      try {
        await fsp.rename(source, destination);
        op.moves[0].done = true; op.status = 'done'; await this.save();
        return path.relative(this.root, destination);
      } catch (error) { op.status = 'failed'; await this.save(); throw error; }
    });
  }
  async organizeExisting({ target, folderName, amount, moves }) {
    return this.exclusive(async () => {
      const parent = await this.validateDirectory(target, false);
      const cents = toCents(amount);
      const name = safeName(folderName);
      if (!cents || amountFromName(name, true) !== cents) throw new Error('整理文件夹名称必须以正确金额结尾');
      if (!Array.isArray(moves) || !moves.length) throw new Error('至少选择一份凭证');
      const folder = path.join(parent, name);
      if (await exists(folder)) throw new Error(`已经存在 ${name} 文件夹`);
      const op = { id: crypto.randomUUID(), type: 'organize', at: Date.now(), status: 'pending', label: `合并同笔附件：${name}`, moves: [], createdDirectory: folder, groupAmountCents: cents };
      const names = new Set();
      for (const item of moves) {
        const source = item.source ? path.resolve(item.source) : path.resolve(this.root, item.relative);
        if (!item.source && (!inside(parent, source) || path.dirname(source) !== parent)) throw new Error('只能整理当前文件夹中的直接文件');
        if (item.source && inside(await fsp.realpath(this.root), await fsp.realpath(source))) throw new Error('外部凭证路径不能指向报销目录内部');
        const stat = await fsp.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能整理普通文件');
        const destinationName = safeName(item.name);
        if (path.extname(destinationName).toLowerCase() !== path.extname(source).toLowerCase()) throw new Error('整理时必须保留文件扩展名');
        if (names.has(destinationName.toLowerCase())) throw new Error('整理后的文件名不能重复');
        names.add(destinationName.toLowerCase());
        op.moves.push({ source, destination: path.join(folder, destinationName), hash: await fingerprint(source), amountCents: cents, done: false });
      }
      this.state.operations.push(op); await this.save();
      try {
        await fsp.mkdir(folder);
        for (const move of op.moves) { await moveNoReplace(move.source, move.destination); move.done = true; await this.save(); }
        op.status = 'done'; await this.save();
        return path.relative(this.root, folder);
      } catch (error) {
        let rollbackFailed = false;
        for (const move of op.moves.filter(move => move.done).reverse()) {
          try { await moveNoReplace(move.destination, move.source); move.done = false; } catch { rollbackFailed = true; }
        }
        await fsp.rmdir(folder).catch(() => {});
        op.status = rollbackFailed ? 'interrupted' : 'failed'; await this.save();
        throw new Error(error.message + (rollbackFailed ? '。部分文件已整理，请在操作记录中核对。' : '。本次整理已回退。'));
      }
    });
  }
  async splitExistingFolder({ relative, groups }) {
    return this.exclusive(async () => {
      const sourceFolder = await this.validateDirectory(relative, false);
      if (!Array.isArray(groups) || groups.length < 2) throw new Error('至少需要拆成两笔费用');
      const parent = path.dirname(sourceFolder);
      const entries = (await fsp.readdir(sourceFolder, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.'));
      if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) throw new Error('待拆分文件夹中只能包含普通文件');
      const available = new Set(entries.map(entry => entry.name.toLowerCase()));
      const used = new Set(), destinations = new Set(), createdDirectories = [];
      const op = { id: crypto.randomUUID(), type: 'organize', at: Date.now(), status: 'pending', label: `按单笔拆分：${path.basename(sourceFolder)}`, moves: [], removedDirectory: sourceFolder, createdDirectories };
      for (const group of groups) {
        const folderName = safeName(group.folderName);
        const cents = toCents(group.amount);
        if (!cents || amountFromName(folderName, true) !== cents) throw new Error(`文件夹 ${folderName} 的金额不正确`);
        const folder = path.join(parent, folderName);
        if (await exists(folder) || destinations.has(folder.toLowerCase())) throw new Error(`已经存在 ${folderName} 文件夹`);
        destinations.add(folder.toLowerCase()); createdDirectories.push(folder);
        if (!Array.isArray(group.files) || !group.files.length) throw new Error(`${folderName} 没有凭证`);
        const names = new Set();
        for (const item of group.files) {
          const sourceName = safeName(item.source);
          if (!available.has(sourceName.toLowerCase())) throw new Error(`找不到待拆分凭证：${sourceName}`);
          if (used.has(sourceName.toLowerCase())) throw new Error(`凭证被重复分配：${sourceName}`);
          used.add(sourceName.toLowerCase());
          const destinationName = safeName(item.name || sourceName);
          if (path.extname(destinationName).toLowerCase() !== path.extname(sourceName).toLowerCase()) throw new Error('拆分时必须保留文件扩展名');
          if (names.has(destinationName.toLowerCase())) throw new Error(`${folderName} 内的新文件名重复`);
          names.add(destinationName.toLowerCase());
          const source = path.join(sourceFolder, sourceName);
          op.moves.push({ source, destination: path.join(folder, destinationName), hash: await fingerprint(source), amountCents: cents, done: false });
        }
      }
      if (used.size !== available.size) throw new Error(`还有 ${available.size - used.size} 份凭证未分配，未执行拆分`);
      const superseded = this.state.operations.find(item => item.status === 'done' && item.createdDirectory === sourceFolder);
      if (superseded) op.supersededOperation = superseded.id;
      this.state.operations.push(op); await this.save();
      try {
        for (const folder of createdDirectories) await fsp.mkdir(folder);
        for (const move of op.moves) { await moveNoReplace(move.source, move.destination); move.done = true; await this.save(); }
        await fsp.rmdir(sourceFolder);
        if (superseded) superseded.status = 'superseded';
        op.status = 'done'; await this.save();
        return createdDirectories.map(folder => path.relative(this.root, folder));
      } catch (error) {
        let rollbackFailed = false;
        await fsp.mkdir(sourceFolder, { recursive: true }).catch(() => { rollbackFailed = true; });
        for (const move of op.moves.filter(move => move.done).reverse()) {
          try { await moveNoReplace(move.destination, move.source); move.done = false; } catch { rollbackFailed = true; }
        }
        for (const folder of createdDirectories.reverse()) await fsp.rmdir(folder).catch(() => {});
        op.status = rollbackFailed ? 'interrupted' : 'failed'; await this.save();
        throw new Error(error.message + (rollbackFailed ? '。部分文件未能回退，请在操作记录中核对。' : '。本次拆分已回退。'));
      }
    });
  }
  async markStatus(relative, complete) {
    return this.exclusive(async () => {
      const source = await this.validateDirectory(relative);
      const archivedRoot = path.join(this.root, '已报销');
      const expectedParent = complete ? this.root : archivedRoot;
      if (path.dirname(source) !== expectedParent || source === archivedRoot) throw new Error('只能更改整个项目的报销状态');
      if (complete) await fsp.mkdir(archivedRoot, { recursive: true });
      const destinationRoot = complete ? archivedRoot : this.root;
      const destination = path.join(destinationRoot, path.basename(source));
      if (await exists(destination)) throw new Error('目标已有同名项目，请先在文件管理器中调整名称');
      const op = { id: crypto.randomUUID(), type: 'status', at: Date.now(), label: complete ? '标记为已报销' : '恢复为正在报销', status: 'pending', moves: [{ source, destination, done: false, directory: true }] };
      this.state.operations.push(op); await this.save();
      await fsp.rename(source, destination);
      op.moves[0].done = true; op.status = 'done'; await this.save();
      return path.relative(this.root, destination);
    });
  }
  async undo(id) {
    return this.exclusive(async () => {
      const op = this.state.operations.find(item => item.id === id);
      if (!op || !['done', 'interrupted'].includes(op.status)) throw new Error('这项操作无法撤回');
      const moves = op.moves.filter(m => m.done).reverse();
      if (!moves.length) throw new Error('没有可撤回的文件');
      // Validate the whole operation before starting to restore anything.
      for (const move of moves) {
        if (await exists(move.source)) throw new Error(`原位置已有同名文件：${path.basename(move.source)}。请先处理，防止覆盖。`);
        if (!await exists(move.destination)) throw new Error('文件已被手动移动，无法自动撤回');
        if (!move.directory && await fingerprint(move.destination) !== move.hash) throw new Error('归档后的文件已修改，暂不自动撤回');
        if (!op.removedDirectory || path.dirname(move.source) !== op.removedDirectory) await fsp.access(path.dirname(move.source));
      }
      try {
        if (op.removedDirectory) await fsp.mkdir(op.removedDirectory);
        for (const move of moves) {
          if (move.directory) await fsp.rename(move.destination, move.source);
          else await moveNoReplace(move.destination, move.source);
          move.done = false;
          await this.save();
        }
        if (op.createdDirectory) await fsp.rmdir(op.createdDirectory).catch(() => {});
        for (const directory of op.createdDirectories || []) await fsp.rmdir(directory).catch(() => {});
        if (op.supersededOperation) {
          const superseded = this.state.operations.find(item => item.id === op.supersededOperation);
          if (superseded && superseded.status === 'superseded') superseded.status = 'done';
        }
        op.status = 'undone'; await this.save();
      } catch (error) { op.status = 'interrupted'; await this.save(); throw error; }
    });
  }
}
module.exports = { Store, inside, safeName, fingerprint, moveNoReplace, PRINT_EXPORTS };
