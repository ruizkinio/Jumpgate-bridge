"use strict";

const DIRECT_TRANSACTION_CONTROLS = new Set([
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

function skipQuoted(sql, index, quote) {
  let cursor = index + 1;
  while (cursor < sql.length) {
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

function skipBracketIdentifier(sql, index) {
  const end = sql.indexOf("]", index + 1);
  return end === -1 ? sql.length : end + 1;
}

function skipBlockComment(sql, index) {
  const end = sql.indexOf("*/", index + 2);
  return end === -1 ? sql.length : end + 2;
}

function containsTransactionControl(sql) {
  let statementStart = true;
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
      cursor += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      cursor = skipQuoted(sql, cursor, character);
      statementStart = false;
      continue;
    }
    if (character === "[") {
      cursor = skipBracketIdentifier(sql, cursor);
      statementStart = false;
      continue;
    }
    if (isWordStart(character)) {
      let end = cursor + 1;
      while (end < sql.length && isWordPart(sql[end])) end += 1;
      if (statementStart) {
        const word = sql.slice(cursor, end).toUpperCase();
        if (DIRECT_TRANSACTION_CONTROLS.has(word)) return true;
        statementStart = false;
      }
      cursor = end;
      continue;
    }

    statementStart = false;
    cursor += 1;
  }

  return false;
}

module.exports = {
  containsTransactionControl,
};
