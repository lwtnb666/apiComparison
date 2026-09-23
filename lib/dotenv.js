'use strict';

const fs = require('node:fs');

/**
 * 极简 .env 加载器（零依赖版 dotenv）。
 * - shell 里已存在的环境变量优先，文件里的值不覆盖
 * - 支持：注释行（# 开头）、空行、键值两侧空白、成对的单/双引号、UTF-8 BOM
 * - 不支持：行内注释（KEY=value # xxx 会把 # xxx 算进值里），注释请单独一行
 * @param file .env 文件路径
 * @returns 实际注入的变量个数（文件不存在返回 0，不算错误）
 */
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 剥 BOM
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }
  return count;
}

module.exports = { loadDotEnv };
