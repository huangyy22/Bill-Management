const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

async function availableFolder(parent, name) {
  let candidate = path.join(parent, name), suffix = 2;
  while (await fsp.access(candidate).then(() => true, () => false)) candidate = path.join(parent, `${name} (${suffix++})`);
  return candidate;
}
function availableFileName(name, occupied) {
  if (!occupied.has(name.toLowerCase())) return name;
  const extension = path.extname(name), stem = path.basename(name, extension);
  let suffix = 2, candidate;
  do candidate = `${stem} (${suffix++})${extension}`; while (occupied.has(candidate.toLowerCase()));
  return candidate;
}
async function exportPrintFolder(source, outputParent, projectName, totalCents) {
  source = path.resolve(source); outputParent = path.resolve(outputParent);
  const relative = path.relative(source, outputParent);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('打印文件夹不能保存在项目内部，请选择其他位置');
  const destination = await availableFolder(outputParent, `${projectName}-打印包`);
  await fsp.mkdir(destination);
  const files = [];
  const occupied = new Set();
  async function copyDirectory(from, relativeDirectory = '') {
    const entries = await fsp.readdir(from, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const sourcePath = path.join(from, entry.name), relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await copyDirectory(sourcePath, relativePath);
      else if (entry.isFile()) {
        const exportedName = availableFileName(entry.name, occupied);
        occupied.add(exportedName.toLowerCase());
        await fsp.copyFile(sourcePath, path.join(destination, exportedName), fs.constants.COPYFILE_EXCL);
        files.push({ source: relativePath, name: exportedName });
      }
    }
  }
  try {
    await copyDirectory(source);
    return { destination, count: files.length };
  } catch (error) {
    throw new Error(`${error.message}。未完成的打印包保留在 ${destination}，可核对后删除。`);
  }
}
module.exports = { exportPrintFolder };
