// Shared by the desktop renderer and the file store so previews follow the same rules.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.receiptNaming = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DOCUMENT_TYPES = ['发票', '行程单', '车票', '付款记录', '订单', '其他附件'];
  function documentTypeFromText(name, text = '') {
    function detect(value) {
      const compact = value.replace(/\s+/g, '');
      if (/行程单|行程明细|行程证明|itinerary|tripreceipt/i.test(compact)) return '行程单';
      if (/铁路电子客票|电子客票|客票|高铁票|火车票|车票|railticket|trainticket/i.test(compact)) return '车票';
      if (/发票|invoice|fapiao/i.test(compact)) return '发票';
      if (/付款记录|支付凭证|转账凭证|交易凭证|电子回单|收款凭证/.test(compact)) return '付款记录';
      if (/订单|order/i.test(compact)) return '订单';
      return '';
    }
    return detect(name) || detect(text);
  }
  function cleanRoute(route) {
    return String(route || '').trim().replace(/[()（）]/g, '').replace(/\s+/g, '').replace(/[→—－至到]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  function categoryLabel(category, route = '') {
    const cleaned = cleanRoute(route);
    return category === '高铁' && cleaned ? `高铁（${cleaned}）` : category;
  }
  function fileName(category, cents, extension, documentType = '', originalName = '', grouped = false, route = '') {
    // Unknown grouped attachments keep their original identity, e.g. a supporting statement.
    if (grouped && !documentType) return originalName;
    const amount = (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    const label = categoryLabel(category, route);
    const type = category === '高铁' && route && documentType === '车票' ? '' : documentType;
    return `${label}${type ? '-' + type : ''}-${amount}${extension}`;
  }
  function numberedName(name, suffix, isDirectory = false) {
    if (suffix === 1) return name;
    const dot = isDirectory ? -1 : name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`;
  }
  function reserveName(name, occupied, isDirectory = false) {
    let suffix = 1, result = name;
    while (occupied.has(result.toLowerCase())) result = numberedName(name, ++suffix, isDirectory);
    occupied.add(result.toLowerCase());
    return result;
  }
  return { DOCUMENT_TYPES, documentTypeFromText, cleanRoute, categoryLabel, fileName, numberedName, reserveName };
});
