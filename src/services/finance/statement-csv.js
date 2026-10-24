const { createHash } = require('node:crypto');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_ROWS = 20000;
const MAX_PREVIEW_ROWS = 100;
const ALLOWED_DELIMITERS = [
  { value: 'comma', character: ',' },
  { value: 'semicolon', character: ';' },
  { value: 'tab', character: '\t' },
];
const FALLBACK_CURRENCIES = new Set(['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'JPY', 'CNY', 'HKD', 'SGD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'INR', 'MXN', 'BRL', 'ZAR', 'KRW', 'TWD', 'THB', 'TRY', 'ILS', 'AED', 'SAR', 'ISK', 'RON', 'BGN', 'UAH', 'PHP', 'IDR', 'MYR', 'VND']);

function parseStatementBuffer(buffer, filename = 'statement.csv', delimiterOverride = null) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Statement input must be a file buffer.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('This CSV is larger than the 10 MB import limit.');
  let text = buffer.toString('utf8');
  if (text.includes('\u0000')) throw new Error('This file does not look like a UTF-8 CSV statement.');
  if (text.includes('\uFFFD')) throw new Error('Some characters could not be read as UTF-8. Export the statement as UTF-8 CSV and try again.');
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('The selected CSV file is empty.');

  const candidates = ALLOWED_DELIMITERS.map(({ value, character }) => {
    const rows = parseDelimited(text, character);
    const headerWidth = rows[0]?.cells.length || 0;
    const consistent = rows.slice(1, Math.min(rows.length, 8)).filter((row) => row.cells.length === headerWidth).length;
    return { delimiter: value, character, rows, score: headerWidth > 1 && rows.length > 1 ? headerWidth * 4 + consistent : 0 };
  }).sort((a, b) => b.score - a.score);
  const chosen = delimiterOverride ? candidates.find((candidate) => candidate.delimiter === delimiterOverride && candidate.score > 0) : candidates[0];
  if (!chosen || chosen.score === 0 || chosen.rows.length < 2) throw new Error('No header and transaction rows were found. Check that this is a delimited CSV file.');
  if (chosen.rows.length - 1 > MAX_DATA_ROWS) throw new Error(`This statement has more than ${MAX_DATA_ROWS.toLocaleString()} rows. Split it into smaller files and import them separately.`);

  const headers = chosen.rows[0].cells.map((header, index) => (String(header || '').trim() || `Column ${index + 1}`).slice(0, 160));
  if (headers.length < 2) throw new Error('The file needs a header row with at least two columns.');
  const rows = chosen.rows.slice(1).filter((row) => row.cells.some((cell) => String(cell || '').trim() !== '')).map((row) => ({
    rowNumber: row.lineNumber,
    cells: headers.map((_header, index) => String(row.cells[index] ?? '').trim()),
  }));
  if (!rows.length) throw new Error('No transaction rows were found below the header.');
  return { filename, delimiter: chosen.delimiter, delimiterOptions: candidates.filter((candidate) => candidate.score > 0).map(({ delimiter, rows: candidateRows }) => ({ value: delimiter, label: delimiter === 'comma' ? 'Comma' : delimiter === 'semicolon' ? 'Semicolon' : 'Tab', columnCount: candidateRows[0].cells.length })), headers, rows, suggestions: suggestMapping(headers) };
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let lineNumber = 1;
  let recordLineNumber = 1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        field += '\n'; lineNumber += 1;
      }
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push({ cells: row, lineNumber: recordLineNumber });
      row = [];
      lineNumber += 1;
      recordLineNumber = lineNumber;
      if (rows.length > MAX_DATA_ROWS + 1) throw new Error(`This statement has more than ${MAX_DATA_ROWS.toLocaleString()} rows.`);
    } else field += character;
  }
  if (quoted) throw new Error('A quoted field is not closed. Check the CSV file around its last row.');
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push({ cells: row, lineNumber: recordLineNumber });
  return rows;
}

function suggestMapping(headers) {
  const normalized = headers.map((header) => header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  const find = (patterns, exclude = []) => {
    const index = normalized.findIndex((header) => !exclude.some((pattern) => pattern.test(header)) && patterns.some((pattern) => pattern.test(header)));
    return index < 0 ? null : index;
  };
  return {
    date: find([/^date$/, /transaction date/, /posted date/, /posting date/, /^booking date$/]),
    description: find([/^description$/, /merchant/, /payee/, /transaction details/, /^details$/, /^name$/]),
    amount: find([/^amount$/, /transaction amount/, /^value$/]),
    debit: find([/^debit$/, /withdrawal/, /money out/, /paid out/, /^charge$/], [/^debit credit$/]),
    credit: find([/^credit$/, /deposit/, /money in/, /paid in/, /^payment received$/], [/^debit credit$/]),
    currency: find([/^currency$/, /currency code/, /^ccy$/]),
    category: find([/^category$/]),
  };
}

function parseAmount(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  let value = String(raw).trim().replace(/[\s\u00a0]/g, '').replace(/[−–]/g, '-').replace(/[’']/g, '');
  const negativeByParentheses = /^\(.*\)$/.test(value);
  value = value.replace(/[()]/g, '').replace(/[^0-9,.'+-]/g, '');
  if (!value || !/[0-9]/.test(value)) return null;
  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    value = value.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? ',' : '.';
    const parts = value.split(separator);
    const finalDigits = parts.at(-1).replace(/[^0-9]/g, '').length;
    if (parts.length > 2 || finalDigits === 3) value = parts.join('');
    else value = parts.slice(0, -1).join('') + '.' + parts.at(-1);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return negativeByParentheses ? -Math.abs(amount) : amount;
}

function isSupportedCurrency(currency) {
  const code = String(currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || code === 'XXX') return false;
  if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('currency').includes(code);
  return FALLBACK_CURRENCIES.has(code);
}

function parseDate(raw, dateFormat = 'auto') {
  const value = String(raw || '').trim();
  let match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (match) return makeDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (!match) return null;
  const first = Number(match[1]); const second = Number(match[2]);
  let year = Number(match[3]); if (year < 100) year += year >= 70 ? 1900 : 2000;
  let month; let day;
  if (dateFormat === 'dmy') { day = first; month = second; }
  else if (dateFormat === 'mdy') { month = first; day = second; }
  else if (dateFormat === 'auto') {
    if (first > 12 && second <= 12) { day = first; month = second; }
    else if (second > 12 && first <= 12) { month = first; day = second; }
    else if (first === second) { month = first; day = second; }
    else return { ambiguous: true };
  } else return null;
  return makeDate(year, month, day);
}

function makeDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildPreview(statement, mapping, { fallbackCurrency = 'CAD', accountLabel = '', existingFingerprints = [], previewOffset = 0 } = {}) {
  const column = (key) => mapping?.[key] === '' || mapping?.[key] === null || mapping?.[key] === undefined ? null : Number(mapping[key]);
  const dateColumn = column('date'); const descriptionColumn = column('description'); const amountColumn = column('amount');
  const debitColumn = column('debit'); const creditColumn = column('credit');
  const currencyColumn = column('currency'); const categoryColumn = column('category');
  if (!Number.isInteger(dateColumn) || !Number.isInteger(descriptionColumn)) throw new Error('Map both a date and a description column before previewing.');
  if (amountColumn === null && debitColumn === null && creditColumn === null) throw new Error('Map an amount column, or at least one debit or credit column.');
  if (amountColumn !== null && (debitColumn !== null || creditColumn !== null)) throw new Error('Choose either one amount column or separate debit and credit columns, not both.');
  if (!isSupportedCurrency(fallbackCurrency)) throw new Error(`“${fallbackCurrency}” is not a supported currency code. Enter a standard three-letter code such as CAD or USD.`);
  for (const index of [dateColumn, descriptionColumn, amountColumn, debitColumn, creditColumn, currencyColumn, categoryColumn].filter((value) => value !== null)) {
    if (!Number.isInteger(index) || index < 0 || index >= statement.headers.length) throw new Error('A mapped column is outside the file’s header range.');
  }

  const prior = new Set(existingFingerprints);
  const seen = new Set();
  const rows = statement.rows.map((sourceRow) => {
    const cells = sourceRow.cells;
    const rawDate = cells[dateColumn]; const parsedDate = parseDate(rawDate, mapping.dateFormat || 'auto');
    const description = cells[descriptionColumn].trim();
    const currencyRaw = currencyColumn === null ? fallbackCurrency : cells[currencyColumn].trim() || fallbackCurrency;
    const currency = currencyRaw.toUpperCase();
    let signedAmount = null;
    if (amountColumn === null && (debitColumn !== null || creditColumn !== null)) {
      const debit = debitColumn === null ? null : parseAmount(cells[debitColumn]);
      const credit = creditColumn === null ? null : parseAmount(cells[creditColumn]);
      if ((debit || 0) !== 0 && (credit || 0) !== 0) return invalidRow(sourceRow, 'Both debit and credit have values.');
      if ((debit || 0) !== 0) signedAmount = -Math.abs(debit);
      else if ((credit || 0) !== 0) signedAmount = Math.abs(credit);
    } else {
      const rawAmount = parseAmount(cells[amountColumn]);
      if (rawAmount !== null) {
        const mode = mapping.amountMode || 'signed';
        signedAmount = mode === 'positive-expense' ? -Math.abs(rawAmount) : mode === 'positive-income' ? Math.abs(rawAmount) : rawAmount;
      }
    }
    if (parsedDate?.ambiguous) return invalidRow(sourceRow, 'Date could mean either month/day or day/month. Choose a date format.');
    if (!parsedDate) return invalidRow(sourceRow, `Could not read date “${rawDate}”.`);
    if (!description) return invalidRow(sourceRow, 'Description is blank.');
    if (description.length > 500) return invalidRow(sourceRow, 'Description is longer than 500 characters.');
    if (signedAmount === null || signedAmount === 0) return invalidRow(sourceRow, 'Amount is blank, invalid, or zero.');
    if (!isSupportedCurrency(currency)) return invalidRow(sourceRow, `Could not read a supported currency code from “${currencyRaw}”.`);
    const category = categoryColumn === null ? 'Uncategorized' : cells[categoryColumn].trim() || 'Uncategorized';
    if (category.length > 100) return invalidRow(sourceRow, 'Category is longer than 100 characters.');
    const direction = signedAmount > 0 ? 'income' : 'expense';
    const fingerprint = transactionFingerprint({ date: parsedDate, description, amount: Math.abs(signedAmount), currency, direction, accountLabel });
    const duplicate = prior.has(fingerprint) || seen.has(fingerprint);
    seen.add(fingerprint);
    return {
      valid: true, rowNumber: sourceRow.rowNumber, date: parsedDate, description,
      amount: Number(Math.abs(signedAmount).toFixed(2)), direction,
      currency, category,
      possibleDuplicate: duplicate,
    };
  });
  const validRows = rows.filter((row) => row.valid);
  const invalidRows = rows.filter((row) => !row.valid);
  const duplicateCount = validRows.filter((row) => row.possibleDuplicate).length;
  return slicePreview({
    rowCount: rows.length,
    validCount: validRows.length,
    invalidCount: invalidRows.length,
    duplicateCount,
    _normalizedRows: validRows,
    _allRows: rows,
  }, previewOffset);
}

function slicePreview(preview, offset = 0) {
  const previewOffset = Math.max(0, Math.floor(Number(offset || 0) / MAX_PREVIEW_ROWS) * MAX_PREVIEW_ROWS);
  const rows = preview._allRows;
  return {
    ...preview,
    previewOffset,
    previewRows: rows.slice(previewOffset, previewOffset + MAX_PREVIEW_ROWS).map((row) => row.valid
      ? { ...row, description: row.description.slice(0, 240), category: row.category.slice(0, 100) }
      : { ...row, raw: row.raw.slice(0, 8).map((cell) => cell.slice(0, 200)) }),
    hasPreviousPreviewRows: previewOffset > 0,
    hasMorePreviewRows: rows.length > previewOffset + MAX_PREVIEW_ROWS,
  };
}

function invalidRow(sourceRow, reason) { return { valid: false, rowNumber: sourceRow.rowNumber, raw: sourceRow.cells, reason }; }

function transactionFingerprint({ date, description, amount, currency, direction = '', accountLabel = '' }) {
  const source = `${accountLabel.normalize('NFKC').toLowerCase().trim()}|${date}|${description.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}|${Number(amount).toFixed(2)}|${currency.toUpperCase()}|${direction}`;
  return createHash('sha256').update(source).digest('hex');
}

module.exports = { MAX_FILE_BYTES, MAX_DATA_ROWS, parseStatementBuffer, suggestMapping, parseAmount, parseDate, buildPreview, slicePreview, isSupportedCurrency, transactionFingerprint };
