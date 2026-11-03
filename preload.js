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
  organize: options => call('organize', options), move: (source, target) => call('move', source, target), remove: relative => call('remove', relative),
  rename: (relative, name) => call('rename', relative, name), exportPrint: relative => call('export-print', relative),
  createProject: name => call('create-project', name), status: (relative, complete) => call('status', relative, complete),
  undo: id => call('undo', id), open: relative => call('open', relative),
  preview: file => call('preview', file),
  filePath: file => webUtils.getPathForFile(file),
  onNavigate: callback => { const listener = (_, direction) => callback(direction); ipcRenderer.on('navigate', listener); return () => ipcRenderer.removeListener('navigate', listener); },
  onProgress: callback => { const listener = (_, value) => callback(value); ipcRenderer.on('analysis-progress', listener); return () => ipcRenderer.removeListener('analysis-progress', listener); }
});
