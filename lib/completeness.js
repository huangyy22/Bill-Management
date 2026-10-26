const path = require('node:path');
const { toCents } = require('./recognize');

const REQUIREMENTS = {
  '出租车': ['付款记录'],
  '网约车': ['发票', '付款记录', '行程单'],
  '住宿': ['发票', '付款记录'],
  '高铁': ['车票', '付款记录']
};

function expenseKind(name) {
  if (/^出租车?[-（(]/.test(name)) return '出租车';
  if (/^(?:网约车|打车)[-（(]/.test(name)) return '网约车';
  if (/^住宿[-（(]/.test(name)) return '住宿';
  if (/^高铁[-（(]/.test(name)) return '高铁';
  return '';
}
function allFileNames(node) {
  if (!node.isDirectory) return [node.name];
  return node.children.flatMap(allFileNames);
}
function documentTypes(kind, names) {
  const types = new Set();
  for (const name of names) {
    if (/付款记录|支付记录|付款凭证|支付凭证|收支详情|银行回单|电子回单/.test(name)) types.add('付款记录');
    if (/发票/.test(name)) types.add('发票');
    if (/行程单/.test(name)) types.add('行程单');
    if (/车票|客票/.test(name) || (kind === '高铁' && /\.pdf$/i.test(name) && !/付款|支付/.test(name))) types.add('车票');
  }
  return types;
}
function sharedItineraryAmounts(nodes) {
  const amounts = new Set();
  for (const node of nodes) for (const name of allFileNames(node)) {
    if (!/共享行程单/.test(name)) continue;
    const content = name.match(/[（(]含([^）)]+)[）)]/)?.[1] || '';
    for (const match of content.matchAll(/\d+(?:\.\d{1,2})?/g)) {
      const cents = toCents(match[0]); if (cents) amounts.add(cents);
    }
  }
  return amounts;
}
function applyCompleteness(nodes) {
  const sharedAmounts = sharedItineraryAmounts(nodes);
  for (const node of nodes) {
    if (!node.isDirectory) continue;
    const kind = expenseKind(node.name);
    const required = REQUIREMENTS[kind];
    if (required) {
      const present = documentTypes(kind, allFileNames(node));
      if (kind === '网约车' && sharedAmounts.has(node.ownAmount)) present.add('行程单');
      const missing = required.filter(type => !present.has(type));
      node.category = kind;
      node.completeness = { checked: true, kind, required, present: [...present], missing, complete: missing.length === 0 };
    }
  }
  for (const node of nodes.filter(node => node.isDirectory)) {
    const checked = node.children.filter(child => child.completeness?.checked);
    node.credentialCheckedCount = checked.length;
    node.credentialCompleteCount = checked.filter(child => child.completeness.complete).length;
    node.credentialIncompleteCount = checked.length - node.credentialCompleteCount;
  }
  return nodes;
}

module.exports = { REQUIREMENTS, expenseKind, documentTypes, applyCompleteness };
