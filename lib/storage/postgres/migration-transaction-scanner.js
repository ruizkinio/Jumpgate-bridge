"use strict";

const DIRECT_TRANSACTION_CONTROLS = new Set([
  "ABORT",
  "BEGIN",
  "COMMIT",
  "END",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
]);

function isWordStart(character) {
  return typeof character === "string" && /[A-Za-z_]/.test(character);
}

function isWordPart(character) {
  return typeof character === "string" && /[A-Za-z0-9_$]/.test(character);
}

function skipQuoted(sql, index, quote, backslashEscapes = false) {
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (backslashEscapes && sql[cursor] === "\\") {
      cursor += Math.min(2, sql.length - cursor);
      continue;
    }
    if (sql[cursor] !== quote) {
      cursor += 1;
      continue;
    }
    if (sql[cursor + 1] === quote) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return sql.length;
}

function skipBlockComment(sql, index) {
  let cursor = index + 2;
  let depth = 1;
  while (cursor < sql.length && depth > 0) {
    if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
      depth += 1;
      cursor += 2;
    } else if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
      depth -= 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return cursor;
}

function dollarQuoteDelimiter(sql, index) {
  if (sql[index] !== "$") return null;
  let cursor = index + 1;
  if (sql[cursor] === "$") return "$$";
  if (!isWordStart(sql[cursor])) return null;
  cursor += 1;
  while (cursor < sql.length && /[A-Za-z0-9_]/.test(sql[cursor])) cursor += 1;
  return sql[cursor] === "$" ? sql.slice(index, cursor + 1) : null;
}

function containsTransactionControl(sql) {
  let statementStart = true;
  let pendingControl = null;
  let cursor = 0;

  while (cursor < sql.length) {
    const character = sql[cursor];
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      const newline = sql.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      cursor = skipBlockComment(sql, cursor);
      continue;
    }
    if (character === ";") {
      statementStart = true;
      pendingControl = null;
      cursor += 1;
      continue;
    }
    if ((character === "E" || character === "e") && sql[cursor + 1] === "'") {
      cursor = skipQuoted(sql, cursor + 1, "'", true);
      statementStart = false;
      pendingControl = null;
      continue;
    }
    if (character === "'" || character === '"') {
      cursor = skipQuoted(sql, cursor, character);
      statementStart = false;
      pendingControl = null;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiter(sql, cursor);
      if (delimiter !== null) {
        const end = sql.indexOf(delimiter, cursor + delimiter.length);
        cursor = end === -1 ? sql.length : end + delimiter.length;
        statementStart = false;
        pendingControl = null;
        continue;
      }
    }
    if (isWordStart(character)) {
      let end = cursor + 1;
      while (end < sql.length && isWordPart(sql[end])) end += 1;
      if (statementStart) {
        const word = sql.slice(cursor, end).toUpperCase();
        if (pendingControl !== null) {
          if (word === "TRANSACTION") return true;
          statementStart = false;
          pendingControl = null;
        } else if (DIRECT_TRANSACTION_CONTROLS.has(word)) {
          return true;
        } else if (word === "START" || word === "PREPARE") {
          pendingControl = word;
        } else {
          statementStart = false;
        }
      }
      cursor = end;
      continue;
    }

    statementStart = false;
    pendingControl = null;
    cursor += 1;
  }

  return false;
}

module.exports = {
  containsTransactionControl,
};
