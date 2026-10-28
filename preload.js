const { contextBridge, ipcRenderer, webUtils } = require('electron');
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('api', {
  snapshot: () => call('snapshot'), categories: () => call('categories'), pickFiles: () => call('pick-files'),
  changeRoot: () => call('change-root'),
  analyze: paths => call('analyze', paths), importFiles: options => call('import', options),
  rename: (relative, name) => call('rename', relative, name), exportPrint: relative => call('export-print', relative),
  createProject: name => call('create-project', name), status: (relative, complete) => call('status', relative, complete),
  undo: id => call('undo', id), open: (relative, reveal) => call('open', relative, reveal),
  preview: file => call('preview', file), export: relative => call('export', relative),
  filePath: file => webUtils.getPathForFile(file),
  onProgress: callback => { const listener = (_, value) => callback(value); ipcRenderer.on('analysis-progress', listener); return () => ipcRenderer.removeListener('analysis-progress', listener); }
});
