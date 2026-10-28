const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amountInput = cents => cents ? (cents / 100).toFixed(2) : '';
const centsOf = value => /^\d{1,9}(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : 0;
const shortAmount = cents => (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
const icon = (name, className = '') => `<i data-lucide="${name}"${className ? ` class="${className}"` : ''} aria-hidden="true"></i>`;
function hydrateIcons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.75, 'aria-hidden': 'true' } }); }
const state = { snapshot: null, categories: [], view: 'active', selected: localStorage.getItem('selectedProject') || '', search: '', category: '', rows: [], grouped: false, analyzing: false, importing: false, totalFiles: 0 };
let toastTimer, dragDepth = 0, autoTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 6000); }
async function attempt(fn) { try { return await fn(); } catch (error) { toast(error.message); } }
function allProjects() { return [...state.snapshot.active, ...state.snapshot.completed]; }
function findNode(relative) {
  let found;
  function walk(nodes) { for (const n of nodes) { if (n.relative === relative) found = n; else if (n.isDirectory) walk(n.children); } }
  walk(allProjects()); return found;
}
// Snapshots come from Node's path module, so separators differ between Windows and Linux.
function parentOf(relative) { const index = Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\')); return index < 0 ? '' : relative.slice(0, index); }
function absoluteOf(relative) { const separator = state.snapshot.root.includes('\\') ? '\\' : '/'; return state.snapshot.root.replace(/[\\/]+$/, '') + separator + relative; }
function projectFor(relative) { return allProjects().find(p => relative === p.relative || relative.startsWith(p.relative + '/') || relative.startsWith(p.relative + '\\')); }
function currentNode() { return findNode(state.selected); }
function categoryOptions(selected, placeholder = true) { return (placeholder ? '<option value="">选择类别</option>' : '') + state.categories.map(c => `<option ${c === selected ? 'selected' : ''}>${escapeHTML(c)}</option>`).join(''); }
function documentTypeOptions(selected) { return '<option value="">普通凭证（不标注）</option>' + receiptNaming.DOCUMENT_TYPES.map(type => `<option ${type === selected ? 'selected' : ''}>${type}</option>`).join(''); }
async function refresh() {
  state.snapshot = await api.snapshot();
  if (state.selected && !findNode(state.selected)) state.selected = '';
  render();
}
function selectProject(relative) {
  state.selected = relative; state.search = ''; state.category = '';
  localStorage.setItem('selectedProject', relative); render();
}
function fileIcon(node) {
  if (node.isDirectory) return `<span class="file-icon">${icon('folder')}</span>`;
  if (/\.pdf$/i.test(node.name)) return `<span class="file-icon pdf">${icon('file-text')}</span>`;
  if (/\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(node.name)) return `<span class="file-icon image">${icon('image')}</span>`;
  return `<span class="file-icon">${icon('file')}</span>`;
}
function nodeMeta(node) {
  if (node.duplicateArchive) return '压缩附件';
  if (node.addedAmount) return `新增 ¥${money(node.addedAmount)}`;
  if (node.isDirectory) return `${node.fileCount} 份`;
  if (!node.ownAmount) return '未标金额';
  return '';
}
function render() {
  const data = state.snapshot;
  $('#active-count').textContent = data.active.length; $('#completed-count').textContent = data.completed.length;
  ['active', 'completed', 'history'].forEach(view => $(`#nav-${view}`).classList.toggle('active', state.view === view));
  $('#root-label').textContent = data.root; $('#root-label').title = data.root;
  $('#projects-label').textContent = state.view === 'completed' ? '已完成的项目' : '正在报销的项目';
  const projects = state.view === 'completed' ? data.completed : data.active;
  $('#project-list').innerHTML = projects.map(p => `<button class="project-item ${projectFor(state.selected)?.relative === p.relative ? 'selected' : ''}" data-project="${escapeHTML(p.relative)}" title="${escapeHTML(p.name)}"><span class="project-dot"></span><span>${escapeHTML(p.name)}</span></button>`).join('') || '<div class="empty side-empty">还没有项目</div>';
  $$('[data-project]').forEach(button => button.onclick = () => { state.view = state.view === 'completed' ? 'completed' : 'active'; selectProject(button.dataset.project); });
  const node = currentNode();
  const history = state.view === 'history';
  const viewLabel = state.view === 'completed' ? '已报销' : history ? '操作记录' : '正在报销';
  $('#breadcrumb').textContent = viewLabel;
  $('#page-title').textContent = history ? '操作记录' : node ? node.name : viewLabel;
  $('#add-files').classList.toggle('hidden', state.view !== 'active');
  const statNodes = node && !history ? [node] : state.view === 'completed' ? data.completed : data.active;
  const sum = statNodes.reduce((s, n) => s + n.amountCents, 0);
  const count = statNodes.reduce((s, n) => s + n.fileCount, 0);
  const unknown = statNodes.reduce((s, n) => s + n.unknownCount, 0);
  const checked = node?.completeness?.checked ? 1 : (node?.credentialCheckedCount || 0);
  const complete = node?.completeness?.checked ? Number(node.completeness.complete) : (node?.credentialCompleteCount || 0);
  const incomplete = checked - complete;
  $('#stats').innerHTML = `<div class="stat-card"><div class="stat-label">${node && !history ? '当前项目金额' : state.view === 'completed' ? '已报销总金额' : '正在报销总金额'}</div><span class="stat-symbol">${icon('wallet-cards')}</span><div class="stat-value"><span class="currency">¥</span>${money(sum)}</div>${unknown ? `<div class="stat-foot alert">${unknown} 份未标金额</div>` : ''}</div><div class="stat-card"><div class="stat-label">${node && !history ? '项目凭证' : '报销项目'}</div><span class="stat-symbol">${icon('files')}</span><div class="stat-value">${node && !history ? count : statNodes.length}<span class="unit">${node && !history ? '份' : '个'}</span></div></div><div class="stat-card"><div class="stat-label">${history ? '可撤回' : checked ? '凭证完整' : '待补金额'}</div><span class="stat-symbol">${icon(history ? 'history' : checked ? 'circle-check' : 'circle-alert')}</span><div class="stat-value">${history ? data.history.filter(h => h.canUndo).length : checked ? complete : unknown}<span class="unit">${history ? '项' : checked ? ` / ${checked} 笔` : '份'}</span></div>${!history && incomplete ? `<div class="stat-foot alert">${incomplete} 笔待补凭证</div>` : ''}</div>`;
  if (history) renderHistory(); else renderWorkspace(node, projects);
  hydrateIcons();
}
function renderWorkspace(node, projects) {
  const data = state.snapshot;
  const isActive = state.view === 'active';
  const currentProject = node && projectFor(node.relative);
  const projectRoot = node && node.relative === currentProject?.relative;
  let html = '';
  if (isActive) html += `<div class="dropzone" id="dropzone" role="button" tabindex="0"><div class="upload-icon">${icon('upload')}</div><h3>拖入凭证</h3><span class="drop-cta">选择文件</span></div>`;
  if (node) {
    const parent = parentOf(node.relative);
    const parentIsProject = parent && findNode(parent);
    html += `<div class="detail-toolbar"><button id="go-back" class="back-button">${icon('arrow-left')} ${parentIsProject ? '上一级' : '全部项目'}</button><span class="path-label">${escapeHTML(node.relative)}</span><button id="open-current" class="secondary-button">打开文件夹 ${icon('external-link')}</button><button id="export-current" class="secondary-button">${icon('file-down')} 导出清单</button>${projectRoot ? `<button id="export-print" class="secondary-button">${icon('printer')} 导出打印文件夹</button><button id="change-status" class="secondary-button">${icon(isActive ? 'circle-check' : 'rotate-ccw')} ${isActive ? '标记已报销' : '恢复正在报销'}</button>` : ''}</div>`;
    if (node.addedAmount) html += `<div class="notice">文件夹原标注 ¥${money(node.ownAmount)}，通过拾账新增 ¥${money(node.addedAmount)}，当前金额 ¥${money(node.amountCents)}。项目原名称保留；新增金额随操作记录保存。</div>`;
    if (node.ownAmount && !node.addedAmount && node.children.some(n => n.unknownCount) === false && node.children.reduce((s, n) => s + n.amountCents, 0) !== node.ownAmount) html += `<div class="notice">此文件夹按名称标注的 ¥${money(node.ownAmount)} 计入；内部可识别明细与标注不同，请核对附件是否属于同一笔费用。</div>`;
  }
  html += `<div class="section-heading"><h2>${node ? '凭证与费用' : '报销项目'} <span class="count-badge">${node ? node.children.length : projects.length}</span></h2><div class="section-actions"><input id="search" class="search-input" placeholder="搜索名称…" aria-label="搜索名称" value="${escapeHTML(state.search)}">${node ? `<select id="category-filter" class="filter-select" aria-label="筛选类别"><option value="">全部类别</option>${categoryOptions(state.category, false)}</select>` : ''}</div></div><div id="table-container"></div>`;
  if (!node && isActive && data.loose.length) html += `<section class="root-files-section"><div class="section-heading"><h2>根目录文件 <span class="count-badge">${data.loose.length}</span></h2></div><div id="root-files"></div></section>`;
  $('#workspace-content').innerHTML = html;
  renderTable(node ? node.children : projects, !node);
  if (!node && isActive && data.loose.length) renderRootFiles(data.loose);
  $('#dropzone')?.addEventListener('click', pickFiles);
  $('#dropzone')?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') pickFiles(); });
  $('#search').oninput = event => { state.search = event.target.value; renderTable(node ? node.children : projects, !node); };
  $('#category-filter')?.addEventListener('change', event => { state.category = event.target.value; renderTable(node.children, false); });
  $('#go-back')?.addEventListener('click', () => { const parent = parentOf(node.relative); selectProject(findNode(parent) ? parent : ''); });
  $('#open-current')?.addEventListener('click', () => attempt(() => api.open(node.relative)));
  $('#export-current')?.addEventListener('click', () => attempt(async () => { if (await api.export(node.relative)) toast('报销清单已导出'); }));
  $('#export-print')?.addEventListener('click', () => attempt(async () => { const result = await api.exportPrint(node.relative); if (result) toast(`已扁平导出 ${result.count} 份凭证到报销目录下的“导出打印”文件夹，文件夹已打开`); }));
  $('#change-status')?.addEventListener('click', () => ask({ title: isActive ? '这笔报销到账了吗？' : '恢复为正在报销？', description: isActive ? '整个项目会移入“已报销”文件夹，凭证与金额一同保留。' : '项目会移回报销根目录，可以继续添加凭证。', confirm: isActive ? '确认已报销' : '恢复项目', action: async () => { await api.status(node.relative, isActive); state.selected = ''; state.view = isActive ? 'completed' : 'active'; await refresh(); toast(isActive ? '项目已移入“已报销”' : '项目已恢复为正在报销'); } }));
}
function renderTable(nodes, projectList) {
  const filtered = nodes.filter(n => n.name.toLowerCase().includes(state.search.toLowerCase()) && (!state.category || n.category === state.category));
  if (!filtered.length) { $('#table-container').innerHTML = `<div class="list-card empty"><div class="empty-symbol">${icon('folder-open')}</div>${nodes.length ? '没有找到匹配的内容' : projectList ? '还没有项目，先创建一个报销项目吧。' : '这里还很清爽，拖入第一份凭证吧。'}</div>`; hydrateIcons(); return; }
  const isActive = state.view === 'active';
  $('#table-container').innerHTML = `<div class="list-card"><table class="table"><colgroup><col style="width:39%"><col style="width:14%"><col style="width:14%"><col style="width:20%"><col style="width:13%"></colgroup><thead><tr><th>${projectList ? '项目名称' : '名称'}</th><th>${projectList ? '凭证数量' : '类别'}</th><th>金额</th><th>${projectList ? '状态' : '凭证状态'}</th><th style="text-align:right">操作</th></tr></thead><tbody>${filtered.map((n, i) => { const meta = nodeMeta(n); return `<tr><td><div class="name-cell">${fileIcon(n)}<div class="name-text"><button class="name-button" data-enter="${i}" title="${escapeHTML(n.name)}">${escapeHTML(n.name)}</button>${meta ? `<small>${escapeHTML(meta)}</small>` : ''}</div></div></td><td>${projectList ? n.fileCount + ' 份' : `<span class="category-pill">${escapeHTML(n.completeness?.kind || (n.isDirectory ? '费用分组' : n.category))}</span>`}</td><td class="amount-cell">${n.duplicateArchive ? '—' : n.amountCents ? '¥ ' + money(n.amountCents) : '<span class="subtle">待补充</span>'}</td><td>${projectList ? `<span class="status-pill ${isActive ? '' : 'complete'}">${isActive ? '正在报销' : '已报销'}</span>` : n.completeness?.checked ? `<span class="credential-badge ${n.completeness.complete ? 'complete' : 'incomplete'}">${n.completeness.complete ? `${icon('circle-check')} 凭证完整` : `${icon('circle-alert')} 缺${escapeHTML(n.completeness.missing.join('、'))}`}</span>` : `<span class="subtle">${new Date(n.modified).toLocaleDateString('zh-CN')}</span>`}</td><td><div class="row-actions"><button data-rename="${i}">改名</button><button data-reveal="${i}" title="在文件管理器中显示">${icon('external-link')}</button><button data-enter="${i}">${n.isDirectory ? '查看' : '预览'}</button></div></td></tr>`; }).join('')}</tbody></table></div>`;
  $$('[data-enter]').forEach(button => button.onclick = () => { const n = filtered[button.dataset.enter]; if (n.isDirectory) selectProject(n.relative); else previewExisting(n); });
  $$('[data-reveal]').forEach(button => button.onclick = () => attempt(() => api.open(filtered[button.dataset.reveal].relative, true)));
  $$('[data-rename]').forEach(button => button.onclick = () => { const n = filtered[button.dataset.rename]; ask({ title: projectList ? '重命名项目文件夹' : n.isDirectory ? '重命名费用文件夹' : '重命名凭证', description: projectList ? '请输入新的文件夹名称。' : n.isDirectory ? '文件夹名称建议以“-金额”结尾，例如“网约车-40”。' : '请输入包含扩展名的新文件名，扩展名需要保持不变。', input: n.name, confirm: '保存名称', action: async name => { await api.rename(n.relative, name.trim()); await refresh(); toast(`${n.isDirectory ? '文件夹' : '文件'}已重命名，可在操作记录中撤回`); } }); });
}
function renderRootFiles(files) {
  $('#root-files').innerHTML = `<div class="list-card"><table class="table root-files-table"><colgroup><col style="width:60%"><col style="width:18%"><col style="width:22%"></colgroup><thead><tr><th>名称</th><th>金额</th><th style="text-align:right">操作</th></tr></thead><tbody>${files.map((file, i) => `<tr><td><div class="name-cell">${fileIcon(file)}<button class="name-button" data-root-preview="${i}" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</button></div></td><td class="amount-cell">${file.amountCents ? '¥ ' + money(file.amountCents) : '<span class="subtle">—</span>'}</td><td><div class="row-actions"><button data-root-rename="${i}">改名</button><button data-root-reveal="${i}" title="在文件管理器中显示">${icon('external-link')}</button><button data-root-preview="${i}">预览</button></div></td></tr>`).join('')}</tbody></table></div>`;
  $$('[data-root-rename]').forEach(button => button.onclick = () => { const file = files[Number(button.dataset.rootRename)]; ask({ title: '重命名文件', description: '请输入包含扩展名的新文件名，扩展名需要保持不变。', input: file.name, confirm: '保存名称', action: async name => { await api.rename(file.relative, name.trim()); await refresh(); toast('文件已重命名，可在操作记录中撤回'); } }); });
  $$('[data-root-reveal]').forEach(button => button.onclick = () => attempt(() => api.open(files[Number(button.dataset.rootReveal)].relative, true)));
  $$('[data-root-preview]').forEach(button => button.onclick = () => previewExisting(files[Number(button.dataset.rootPreview)]));
}
function renderHistory() {
  const statuses = { done: '已完成', pending: '处理中', undone: '已撤回', failed: '已回退', interrupted: '需要检查', superseded: '已重新整理' };
  $('#workspace-content').innerHTML = `<div class="section-heading"><h2>最近的操作 <span class="count-badge">${state.snapshot.history.length}</span></h2></div><div class="list-card">${state.snapshot.history.length ? state.snapshot.history.map(op => `<div class="history-row"><div class="history-icon">${icon(op.type === 'import' ? 'arrow-down-to-line' : 'circle-check')}</div><div class="history-info"><strong>${escapeHTML(op.label)}</strong><small>${new Date(op.at).toLocaleString('zh-CN')}${op.extraCopies.length ? ' · 有额外副本，请核对' : ''}</small></div><span class="history-state">${statuses[op.status] || op.status}</span>${op.canUndo ? `<button class="secondary-button" data-undo="${op.id}">${icon('undo-2')} 撤回操作</button>` : ''}</div>`).join('') : `<div class="empty"><div class="empty-symbol">${icon('history')}</div>暂无操作记录</div>`}</div>`;
  $$('[data-undo]').forEach(button => button.onclick = () => ask({ title: '撤回这次操作？', description: '文件会回到操作前的位置，项目金额也会恢复。', confirm: '确认撤回', action: async () => { await api.undo(button.dataset.undo); await refresh(); toast('已撤回，文件已恢复到原位置'); } }));
}
function ask({ title, description, input, confirm = '确认', action }) {
  $('#simple-title').textContent = title; $('#simple-description').textContent = description;
  $('#simple-input').classList.toggle('hidden', input === undefined); $('#simple-input').value = input || '';
  $('#simple-confirm').textContent = confirm; $('#simple-error').textContent = '';
  $('#simple-overlay').classList.remove('hidden');
  $('#simple-confirm').onclick = async () => {
    $('#simple-confirm').disabled = true;
    try { await action($('#simple-input').value); $('#simple-overlay').classList.add('hidden'); }
    catch (error) { $('#simple-error').textContent = error.message; }
    finally { $('#simple-confirm').disabled = false; }
  };
  $('#simple-cancel').onclick = () => { if (!$('#simple-confirm').disabled) $('#simple-overlay').classList.add('hidden'); };
  if (input !== undefined) setTimeout(() => { $('#simple-input').focus(); $('#simple-input').select(); }, 30);
}
function newProject() {
  const today = new Date();
  const date = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  ask({ title: '新建报销项目', description: '例如“2026.10.20报销”或“RoboCup 差旅”。文件夹会创建在你的报销目录里。', input: `${date}报销`, confirm: '创建项目', action: async name => { const relative = await api.createProject(name); state.view = 'active'; await refresh(); selectProject(relative); toast('项目已创建，可以拖入凭证了'); } });
}
async function pickFiles() { await attempt(async () => { const paths = await api.pickFiles(); if (paths.length) await beginImport(paths); }); }
async function beginImport(paths) {
  if (state.analyzing || state.importing || !$('#import-overlay').classList.contains('hidden')) { toast('请先完成或关闭当前导入'); return; }
  if (!state.snapshot.active.length) { toast('请先新建一个报销项目'); newProject(); return; }
  if (paths.length > 200) { toast('每次最多导入 200 个文件'); return; }
  state.rows = []; state.grouped = false; state.analyzing = true; state.totalFiles = paths.length;
  const selectedProject = projectFor(state.selected);
  const target = selectedProject && state.snapshot.active.some(p => p.relative === selectedProject.relative) ? state.selected : '';
  const targets = [];
  function walk(nodes, level = 0) { for (const n of nodes.filter(n => n.isDirectory)) { targets.push({ ...n, level }); walk(n.children, level + 1); } }
  walk(state.snapshot.active);
  $('#import-target').innerHTML = `<option value="" ${target ? '' : 'selected'}>请选择要归档的报销项目…</option>` + targets.map(p => `<option value="${escapeHTML(p.relative)}" ${p.relative === target ? 'selected' : ''}>${'　'.repeat(p.level)}${escapeHTML(p.name)}</option>`).join('');
  $('#auto-import').checked = localStorage.getItem('autoImport') === 'true';
  $('#group-category').innerHTML = categoryOptions(''); $('#group-amount').value = ''; $('#group-route').value = '';
  $('#import-overlay').classList.remove('hidden');
  $('#import-warning').classList.add('hidden');
  delete $('#import-warning').dataset.serverError;
  renderImport();
  const unsubscribe = api.onProgress(({ row, done, total }) => {
    state.rows.push({ ...row, amount: amountInput(row.amountCents), category: row.category || '' });
    $('#analysis-status').textContent = `正在识别 ${done} / ${total} 份凭证…`;
    renderImport();
  });
  try {
    const results = await api.analyze(paths);
    state.rows = results.map(row => ({ ...row, amount: amountInput(row.amountCents), category: row.category || '' }));
  }
  catch (error) { console.error('凭证识别失败', error); toast(error.message); }
  finally { unsubscribe(); state.analyzing = false; renderImport(); scheduleAutoImport(); }
}
function renderImport() {
  $('#mode-separate').classList.toggle('selected', !state.grouped); $('#mode-grouped').classList.toggle('selected', state.grouped);
  $('#group-fields').classList.toggle('hidden', !state.grouped);
  $('#group-route-label').classList.toggle('hidden', !state.grouped || $('#group-category').value !== '高铁');
  $('#analysis-status').textContent = state.analyzing ? `正在识别 ${state.rows.length} / ${state.totalFiles} 份凭证，图片识别可能需要片刻…` : `已读取 ${state.rows.length} 份凭证 · 请核对类别和实付金额`;
  $('#analysis-status').classList.toggle('loading', state.analyzing);
  $('#close-import').disabled = state.analyzing || state.importing;
  $('#import-rows').innerHTML = state.rows.map((row, i) => `<div class="import-row ${row.error ? 'error-row' : ''}" id="import-row-${i}"><div class="import-file-header">${fileIcon({ name: row.name })}<div class="import-file-info"><strong title="${escapeHTML(row.name)}">第 ${i + 1} 份 · ${escapeHTML(row.name)}</strong><small>${escapeHTML(row.error || (row.source + (row.note ? ' · ' + row.note : ' · 已识别')))}</small></div><span class="missing-badge hidden" id="missing-badge-${i}">待补全</span>${!row.error ? `<button class="preview-button" data-preview-import="${i}">查看凭证</button>` : ''}<button class="remove-row" data-remove="${i}" title="从本次导入移除" ${state.analyzing || state.importing ? 'disabled' : ''}>${icon('x')}</button></div>${!row.error ? `<div class="import-fields ${state.grouped ? 'attachment-fields' : ''}">${!state.grouped ? `<label>费用类别<select data-category="${i}" aria-describedby="category-error-${i}">${categoryOptions(row.category)}</select><span id="category-error-${i}" class="field-error hidden">请选择费用类别</span></label><label>金额（元）<input data-amount="${i}" type="text" inputmode="decimal" value="${escapeHTML(row.amount)}" placeholder="0.00" aria-describedby="amount-error-${i}"><span id="amount-error-${i}" class="field-error hidden">请填写正确金额</span></label>${row.category === '高铁' ? `<label>高铁行程<input data-route="${i}" type="text" value="${escapeHTML(row.route || '')}" placeholder="长沙南-杭州东"></label>` : ''}` : ''}<label>凭证类型<select data-document-type="${i}">${documentTypeOptions(row.documentType)}</select></label><div class="rename-preview" id="rename-${i}"></div></div>` : ''}</div>`).join('');
  $$('[data-remove]').forEach(button => button.onclick = () => { clearTimeout(autoTimer); state.rows.splice(Number(button.dataset.remove), 1); renderImport(); });
  $$('[data-category]').forEach(select => select.onchange = () => { state.rows[select.dataset.category].category = select.value; renderImport(); });
  $$('[data-amount]').forEach(input => input.oninput = () => { state.rows[input.dataset.amount].amount = input.value.trim(); updateImportTotals(); });
  $$('[data-document-type]').forEach(select => select.onchange = () => { state.rows[select.dataset.documentType].documentType = select.value; updateImportTotals(); });
  $$('[data-route]').forEach(input => input.oninput = () => { state.rows[input.dataset.route].route = input.value; updateImportTotals(); });
  $$('[data-preview-import]').forEach(button => button.onclick = () => previewFile(state.rows[button.dataset.previewImport].path, state.rows[button.dataset.previewImport].name));
  updateImportTotals();
  hydrateIcons();
}
function importProblem() {
  if (!$('#import-target').value) return '请先选择要归档的报销项目';
  if (state.rows.some(r => r.error)) return '请先移除不能导入的文件';
  const rows = state.rows.filter(r => !r.error);
  if (!rows.length) return '请添加凭证';
  if (state.grouped) return !$('#group-category').value || !centsOf($('#group-amount').value.trim()) ? '请填写这笔费用的类别和总金额' : '';
  return rows.some(r => !r.category || !centsOf(r.amount)) ? '请补全每份凭证的类别和正确金额' : '';
}
function updateImportValidation() {
  const issues = [];
  const checking = !state.analyzing && !state.importing;
  const mark = (selector, invalid) => {
    const field = $(selector);
    if (field) field.setAttribute('aria-invalid', checking && invalid ? 'true' : 'false');
  };
  if (!$('#import-target').value) issues.push({ label: '请选择归档到哪个报销项目', selector: '#import-target' });
  mark('#import-target', !$('#import-target').value);
  let missingCategories = 0, missingAmounts = 0;
  state.rows.forEach((row, i) => {
    const missingCategory = !row.error && !state.grouped && !row.category;
    const missingAmount = !row.error && !state.grouped && !centsOf(row.amount);
    mark(`[data-category="${i}"]`, missingCategory);
    mark(`[data-amount="${i}"]`, missingAmount);
    $(`#category-error-${i}`)?.classList.toggle('hidden', !checking || !missingCategory);
    $(`#amount-error-${i}`)?.classList.toggle('hidden', !checking || !missingAmount);
    const incomplete = !!row.error || missingCategory || missingAmount;
    $(`#import-row-${i}`)?.classList.toggle('needs-attention', checking && incomplete);
    $(`#missing-badge-${i}`)?.classList.toggle('hidden', !checking || !incomplete);
    if (missingCategory) missingCategories++;
    if (missingAmount) missingAmounts++;
    if (incomplete) {
      const reason = row.error || [missingCategory ? '未选择类别' : '', missingAmount ? (row.amount ? '金额格式不正确' : '未填写金额') : ''].filter(Boolean).join('、');
      issues.push({ label: `第 ${i + 1} 份 · ${row.name}：${reason}`, index: i, selector: row.error ? `[data-remove="${i}"]` : missingCategory ? `[data-category="${i}"]` : `[data-amount="${i}"]` });
    }
  });
  const groupCategoryMissing = state.grouped && !$('#group-category').value;
  const groupAmountMissing = state.grouped && !centsOf($('#group-amount').value.trim());
  mark('#group-category', groupCategoryMissing); mark('#group-amount', groupAmountMissing);
  if (groupCategoryMissing) issues.push({ label: '请选择这笔费用的类别', selector: '#group-category' });
  if (groupAmountMissing) issues.push({ label: '请填写这笔费用的正确总金额', selector: '#group-amount' });
  if (!state.rows.length) issues.push({ label: '本次没有可归档的凭证，请重新添加', selector: '#close-import' });
  $('#import-validation').classList.toggle('hidden', !checking);
  $('#import-validation').classList.toggle('ready', !issues.length);
  const count = issues.filter(issue => issue.index !== undefined).length;
  const details = [missingCategories ? `${missingCategories} 份缺类别` : '', missingAmounts ? `${missingAmounts} 份金额待补全` : ''].filter(Boolean).join('，');
  $('#validation-title').textContent = issues.length ? (count ? `还有 ${count} 份凭证待处理${details ? `（${details}）` : ''}` : '归档前还有信息需要补充') + '，点击下方提醒定位' : '信息已补全，可以确认归档';
  $('#validation-items').innerHTML = issues.map((issue, i) => `<button type="button" class="validation-item" data-validation="${i}" title="${escapeHTML(issue.label)}">${icon('triangle-alert')} ${escapeHTML(issue.label)} <span aria-hidden="true">${icon('arrow-right')}</span></button>`).join('');
  $$('[data-validation]').forEach(button => button.onclick = () => {
    const field = $(issues[Number(button.dataset.validation)].selector);
    if (field) { field.scrollIntoView({ behavior: 'smooth', block: 'center' }); field.focus({ preventScroll: true }); }
  });
  hydrateIcons();
}
function updateImportTotals() {
  const rows = state.rows.filter(r => !r.error);
  const total = state.grouped ? centsOf($('#group-amount').value.trim()) : rows.reduce((sum, row) => sum + centsOf(row.amount), 0);
  $('#import-total').textContent = '¥' + money(total); $('#import-count').textContent = `${rows.length} 份凭证${state.grouped ? ' · 计为 1 笔' : ''}`;
  const occupied = new Set((findNode($('#import-target').value)?.children || []).map(node => node.name.toLowerCase()));
  const groupCategory = $('#group-category').value, groupCents = centsOf($('#group-amount').value.trim()), groupRoute = $('#group-route').value;
  const folderName = state.grouped && groupCategory && groupCents ? receiptNaming.reserveName(`${receiptNaming.categoryLabel(groupCategory, groupRoute)}-${shortAmount(groupCents)}`, occupied, true) : '';
  const fileNames = state.grouped ? new Set() : occupied;
  rows.forEach(row => {
    const label = $(`#rename-${state.rows.indexOf(row)}`);
    const category = state.grouped ? groupCategory : row.category;
    const cents = state.grouped ? groupCents : centsOf(row.amount);
    if (!label) return;
    if (!category || !cents) { label.textContent = '补全后自动生成文件名'; return; }
    const route = state.grouped ? groupRoute : row.route;
    const basename = receiptNaming.fileName(category, cents, row.extension, row.documentType || '', row.name, state.grouped, route);
    const name = receiptNaming.reserveName(basename, fileNames);
    const relative = folderName ? folderName + ' / ' + name : name;
    label.innerHTML = `归档为 <strong>${escapeHTML(relative)}</strong>`;
    label.title = relative + '（若归档时出现新的同名文件，将继续自动编号）';
  });
  const problem = importProblem();
  $('#confirm-import').disabled = state.analyzing || state.importing || !!problem;
  if (state.importing || state.analyzing) $('#confirm-import').textContent = state.importing ? '正在归档…' : '正在识别…';
  else $('#confirm-import').innerHTML = `确认并归档 ${rows.length} 份 ${icon('arrow-right')}`;
  $('#confirm-import').title = problem;
  updateImportValidation();
  const sameAmount = !state.grouped && rows.some((r, i) => centsOf(r.amount) && rows.some((other, j) => i !== j && r.category === other.category && centsOf(r.amount) === centsOf(other.amount) && (!(r.route && other.route) || receiptNaming.cleanRoute(r.route) === receiptNaming.cleanRoute(other.route))));
  $('#same-expense-note').classList.toggle('hidden', !sameAmount || state.analyzing || state.importing);
  $('#same-expense-text').textContent = '有同类同价凭证：同一笔费用的发票、行程单请合为一笔；不同车票各记一笔，同名会自动编号。';
  const pair = sameAmount && rows.length === 2 && rows[0].category && rows[0].documentType && rows[1].documentType && rows[0].documentType !== rows[1].documentType;
  $('#merge-current-batch').classList.toggle('hidden', !pair);
  $('#merge-current-batch').textContent = pair ? `这两份属于同一笔：合并计入 ¥${money(centsOf(rows[0].amount))}` : '';
  if (problem && !state.analyzing) { $('#import-warning').textContent = problem + '。识别不全时可点“查看凭证”，手动填写金额后归档。'; $('#import-warning').classList.remove('hidden'); }
  else if (!$('#import-warning').dataset.serverError) $('#import-warning').classList.add('hidden');
}
function scheduleAutoImport() {
  clearTimeout(autoTimer);
  if (!$('#auto-import').checked || state.grouped || state.analyzing || importProblem()) return;
  if (state.rows.some(r => r.confidence !== 'high')) return;
  const key = row => row.category + ':' + receiptNaming.cleanRoute(row.route) + ':' + centsOf(row.amount);
  if (new Set(state.rows.map(key)).size !== state.rows.length) return;
  $('#analysis-status').textContent = '类别与金额已可靠识别，3 秒后自动归档；修改内容或关闭窗口可取消。';
  autoTimer = setTimeout(() => { if (!$('#import-overlay').classList.contains('hidden') && !importProblem() && $('#auto-import').checked) performImport(); }, 3000);
}
async function performImport() {
  if (state.importing || state.analyzing || importProblem()) return;
  clearTimeout(autoTimer); state.importing = true; updateImportTotals();
  const target = $('#import-target').value;
  try {
    const result = await api.importFiles({ target, rows: state.rows.filter(r => !r.error).map(r => ({ path: r.path, category: r.category, amount: r.amount, documentType: r.documentType || '', route: r.route || '' })), grouped: state.grouped, groupCategory: $('#group-category').value, groupAmount: $('#group-amount').value.trim(), groupRoute: $('#group-route').value.trim() });
    $('#import-overlay').classList.add('hidden');
    state.view = 'active'; state.selected = target; state.search = ''; state.category = '';
    await refresh(); toast(result.attachmentOnly ? `已补充 ${result.count} 份凭证，原费用金额保持不变。需要时可在操作记录中撤回。` : `已归档 ${result.count} 份凭证，计入 ¥${money(result.amountCents)}。需要时可在操作记录中撤回。`);
  } catch (error) { $('#import-warning').textContent = error.message; $('#import-warning').dataset.serverError = 'true'; $('#import-warning').classList.remove('hidden'); }
  finally { state.importing = false; updateImportTotals(); }
}
async function previewExisting(node) { await previewFile(absoluteOf(node.relative), node.name, node.relative); }
async function previewFile(file, name, relative) {
  await attempt(async () => {
    const result = await api.preview(file);
    if (!result) { if (relative) await api.open(relative); else toast('此类型可归档，暂不支持内置预览'); return; }
    $('#preview-title').textContent = name;
    $('#preview-body').replaceChildren();
    const element = document.createElement(result.mime === 'application/pdf' ? 'iframe' : 'img');
    element.src = `data:${result.mime};base64,${result.data}`;
    if (element.tagName === 'IMG') element.alt = name; else element.title = name;
    $('#preview-body').append(element); $('#preview-overlay').classList.remove('hidden');
  });
}
function closeImport() { if (!state.analyzing && !state.importing) { clearTimeout(autoTimer); $('#import-overlay').classList.add('hidden'); } }
['active', 'completed', 'history'].forEach(view => $(`#nav-${view}`).onclick = () => { state.view = view; state.selected = ''; state.search = ''; state.category = ''; render(); });
$('#new-project').onclick = $('#new-project-icon').onclick = newProject;
$('#add-files').onclick = pickFiles;
$('#open-root').onclick = () => attempt(() => api.open(''));
$('#refresh').onclick = () => attempt(async () => { await refresh(); toast('目录已刷新'); });
$('#close-import').onclick = closeImport;
$('#confirm-import').onclick = performImport;
$('#mode-separate').onclick = () => { clearTimeout(autoTimer); state.grouped = false; renderImport(); };
$('#mode-grouped').onclick = () => { clearTimeout(autoTimer); state.grouped = true; const first = state.rows.find(r => !r.error); if (first) { $('#group-category').value = first.category; $('#group-amount').value = first.amount; $('#group-route').value = first.route || ''; } renderImport(); };
$('#merge-current-batch').onclick = () => $('#mode-grouped').click();
$('#group-category').onchange = () => { $('#group-route-label').classList.toggle('hidden', $('#group-category').value !== '高铁'); updateImportTotals(); };
$('#group-amount').oninput = $('#group-route').oninput = updateImportTotals;
$('#auto-import').onchange = () => { localStorage.setItem('autoImport', $('#auto-import').checked); setTimeout(scheduleAutoImport, 0); };
$('#import-overlay').addEventListener('input', () => clearTimeout(autoTimer));
$('#import-overlay').addEventListener('change', () => { delete $('#import-warning').dataset.serverError; clearTimeout(autoTimer); });
$('#import-target').onchange = () => { updateImportTotals(); setTimeout(scheduleAutoImport, 0); };
$('#close-preview').onclick = () => { $('#preview-overlay').classList.add('hidden'); $('#preview-body').replaceChildren(); };
$('#simple-input').onkeydown = event => { if (event.key === 'Enter') $('#simple-confirm').click(); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (!$('#preview-overlay').classList.contains('hidden')) $('#close-preview').click(); else if (!$('#simple-overlay').classList.contains('hidden')) $('#simple-cancel').click(); else closeImport(); } });
document.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
document.addEventListener('dragenter', event => { event.preventDefault(); if (!event.dataTransfer.types.includes('Files')) return; dragDepth++; if ($('#import-overlay').classList.contains('hidden')) $('#drag-overlay').classList.remove('hidden'); });
document.addEventListener('dragleave', event => { event.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; $('#drag-overlay').classList.add('hidden'); } });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('#drag-overlay').classList.add('hidden');
  attempt(async () => {
    const paths = [...event.dataTransfer.files].map(file => api.filePath(file)).filter(Boolean);
    if (paths.length) await beginImport(paths);
    else toast('未收到本地文件。请先把图片保存到电脑，从文件夹拖入，或点击“添加凭证”。');
  });
});
window.addEventListener('focus', () => { if (state.snapshot && !state.analyzing && !state.importing) attempt(refresh); });
async function init() { state.categories = await api.categories(); await refresh(); }
init().catch(error => { $('#workspace-content').textContent = '读取目录失败：' + error.message; });
