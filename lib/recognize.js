const path = require('node:path');
const { documentTypeFromText } = require('./naming');

const CATEGORIES = ['出租车', '网约车', '高铁', '机票', '住宿', '餐饮', '快递费', '物资费', '打印费', '其他'];
const RULES = [
  ['出租车', /出租汽车|出租车|客运出租|出租[-－—]/],
  ['网约车', /打车|滴滴|高德|网约车|出行服务/],
  ['高铁', /高铁|火车|铁路|动车|12306/],
  ['机票', /机票|航空|航班|民航/],
  ['住宿', /住宿|酒店|宾馆|房费/],
  ['快递费', /快递|顺丰|邮寄|邮政|中通|圆通|申通|运费/],
  ['打印费', /打印|复印|印刷|图文/],
  ['餐饮', /餐饮|餐费|饭店|美团|外卖|食品/],
  ['物资费', /物资|耗材|器材|设备|配件|数据线|相机|支架|拓展坞|硬盘|电池|桨叶|天线|标定|小球|投屏|遥控|电子元件/]
];

function toCents(value) {
  const text = String(value ?? '').trim().replace(/[,，￥¥\s]/g, '');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
function amountLabel(cents) { return (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); }
function stemFor(name, isDirectory = false) { return isDirectory ? name : path.parse(name).name; }
function amountFromName(name, isDirectory = false) {
  const stem = stemFor(name, isDirectory).replace(/\s*[（(]\d+[）)]$/, '');
  const match = stem.match(/[-－—]\s*(\d{1,9}(?:\.\d{1,2})?)\s*(?:元)?$/)
    || stem.match(/(?:打车|出租|高铁|火车|快递费?|餐费|住宿|打印费?)\s*(\d{1,7}(?:\.\d{1,2})?)\s*(?:元)?$/)
    || stem.match(/[【\[]\s*(\d{1,9}(?:\.\d{1,2})?)\s*元/);
  return match ? toCents(match[1]) : null;
}
function compactChinese(text) { return text.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, ''); }
function categoryFromText(text) { return RULES.find(([, regex]) => regex.test(compactChinese(text)))?.[0] || ''; }
const PINYIN_STATIONS = new Map([
  ['changshanan', '长沙南'], ['hangzhoudong', '杭州东'], ['changshanan', '长沙南'], ['beijingnan', '北京南'],
  ['shanghaihongqiao', '上海虹桥'], ['guangzhounan', '广州南'], ['shenzhendong', '深圳东'], ['shenzhenbei', '深圳北'],
  ['wuhanzhan', '武汉'], ['wuhan', '武汉'], ['nanjingnan', '南京南'], ['hefeinan', '合肥南']
]);
function routeFromText(text) {
  const normalized = String(text || '').replace(/[()（）]/g, ' ');
  const labeled = normalized.match(/出发(?:站|地)?\s*[:：]?\s*([\u4e00-\u9fff]{2,8})(?:站)?[\s\S]{0,80}?到达(?:站|地)?\s*[:：]?\s*([\u4e00-\u9fff]{2,8})(?:站)?/);
  if (labeled && labeled[1] !== labeled[2]) return `${labeled[1].replace(/站$/, '')}-${labeled[2].replace(/站$/, '')}`;
  const latin = [...normalized.toLowerCase().matchAll(/[a-z]{4,24}/g)].map(match => PINYIN_STATIONS.get(match[0])).filter(Boolean);
  if (latin.length >= 2 && latin[0] !== latin[1]) return `${latin[0]}-${latin[1]}`;
  const compact = compactChinese(normalized);
  const ticket = compact.match(/(?:^|\s)([\u4e00-\u9fff]{2,7})站\s*(?:G|D|C|Z|T|K)\d+\s*([\u4e00-\u9fff]{2,7})站(?:\s|$)/i);
  if (ticket && ticket[1] !== ticket[2]) return `${ticket[1]}-${ticket[2]}`;
  return '';
}

function recognize(name, text = '') {
  const namedAmount = amountFromName(name);
  const category = categoryFromText(name) || categoryFromText(text);
  const documentType = documentTypeFromText(name, text);
  const route = routeFromText(name) || routeFromText(text);
  if (namedAmount) return { category, documentType, route, amountCents: namedAmount, confidence: 'high', source: '文件名', note: '' };
  const normalized = compactChinese(text).replace(/[ \t]+/g, ' ');
  const candidates = [];
  const patterns = [
    /(?:小写)[^\d\n]{0,16}[¥￥]?\s*([\d,]+\.\d{2})(?![\d.])/g,
    /(?:交易金额|记账金额)[^\d\n]{0,16}([\d,]+\.\d{2})(?![\d.])|(?:价税合计|合计金额|总金额|金额合计|实付金额|实付款|实付|支付金额|订单金额|票价|车票价格|应付金额|本次行程金额)[^\d\n]{0,30}[¥￥]?\s*([\d,]+\.\d{2}|\d{1,7})(?![\d.])/g,
    /[¥￥]\s*([\d,]+\.\d{2})(?!\d)/g
  ];
  for (let priority = 0; priority < patterns.length; priority++) {
    for (const match of normalized.matchAll(patterns[priority])) {
      const cents = toCents(match[1] || match[2]);
      if (cents && !candidates.some(item => item.cents === cents && item.priority <= priority)) candidates.push({ cents, priority });
    }
    if (candidates.length) break;
  }
  const amounts = [...new Set(candidates.map(item => item.cents))];
  return {
    category, documentType, route, amountCents: amounts.length === 1 ? amounts[0] : null,
    confidence: amounts.length === 1 && candidates[0].priority < 2 ? 'high' : 'review',
    source: text ? '凭证内容' : '待补充',
    note: amounts.length > 1 ? '发现多个金额，请核对实付或价税合计金额' : amounts.length === 1 ? '请核对凭证金额' : '未识别到明确金额，请手动填写'
  };
}
module.exports = { CATEGORIES, toCents, amountLabel, amountFromName, categoryFromText, routeFromText, recognize };
