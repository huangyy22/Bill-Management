// Rebuild visual rows: OCR often returns the entire left column before the
// right column, separating a bank transaction amount from its label.
function wordsToText(words) {
  const rows = [];
  for (const word of [...words].sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2))) {
    const center = word.y + word.height / 2;
    let row = rows.find(row => Math.abs(row.y - center) < Math.min(row.height, word.height) * .6);
    if (!row) { row = { y: center, height: word.height, words: [] }; rows.push(row); }
    row.words.push(word);
  }
  return rows.map(row => row.words.sort((a, b) => a.x - b.x).map(word => word.text).join(' ')).join('\n');
}
function supplementAmounts(native, numeric) {
  let words = [...native];
  for (const word of numeric) {
    // Only supplement decimal money, never account numbers, dates or integers.
    if (word.confidence < 70 || !/^[-+¥￥]?[\d,]+\.\d{2}$/.test(word.text)) continue;
    const overlaps = words.filter(other =>
      Math.abs(other.y + other.height / 2 - word.y - word.height / 2) < Math.max(other.height, word.height) * .5 &&
      other.x < word.x + word.width && other.x + other.width > word.x);
    // Preserve an existing complete decimal, but replace broken glyphs such
    // as "2 / · 艿" with the confident numeric word occupying the same box.
    if (overlaps.some(other => /\d[,.]\d/.test(other.text))) continue;
    words = words.filter(other => !overlaps.includes(other));
    words.push(word);
  }
  return words;
}
module.exports = { wordsToText, supplementAmounts };
