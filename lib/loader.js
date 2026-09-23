'use strict';

const fs = require('node:fs');
const path = require('node:path');

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * fixture 加载 + 校验。fixture 是多人手工维护的 JSON，写错是常态：
 * 所有错误一次性收集（带文件名和位置），绝不跑到一半才炸。
 */

function validateApi(api, file, index, errors) {
  const where = `${file} apis[${index}]${api && api.name ? ` (${api.name})` : ''}`;
  if (!api || typeof api !== 'object' || Array.isArray(api)) {
    errors.push(`${where}: 接口定义必须是对象`);
    return false;
  }
  let ok = true;
  const fail = (msg) => { errors.push(`${where}: ${msg}`); ok = false; };
  if (typeof api.name !== 'string' || !api.name) fail('缺少 name（字符串）');

  // 新老接口的 method + path 全部必填写全（规范要求：后期回查"这 fixture 对的是老系统哪个接口"全靠 oldApi）
  const apiShapeOk = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && typeof v.method === 'string' && METHODS.has(v.method.toUpperCase())
    && typeof v.path === 'string' && v.path.startsWith('/');
  if (!apiShapeOk(api.oldApi)) fail('oldApi 必填且写全：{ "method": "POST", "path": "/老系统/path" }（老接口标识，纯存档不发请求）');
  if (!apiShapeOk(api.newApi)) fail('newApi 必填且写全：{ "method": "POST", "path": "/新系统/path" }（新接口，实际请求用）');

  if (!Object.hasOwn(api, 'response')) fail('缺少 response（人工维护的老响应）');
  if (api.request !== undefined && (typeof api.request !== 'object' || api.request === null || Array.isArray(api.request))) {
    fail('request 必须是对象（可含 query / body / headers）');
  }
  if (api.keyOverrides !== undefined && (typeof api.keyOverrides !== 'object' || api.keyOverrides === null || Array.isArray(api.keyOverrides))) {
    fail('keyOverrides 必须是对象（老原始 key → 新实际 key）');
  }
  if (api.ignorePaths !== undefined && (!Array.isArray(api.ignorePaths) || api.ignorePaths.some((p) => typeof p !== 'string'))) {
    fail('ignorePaths 必须是字符串数组（规范化路径）');
  }
  return ok;
}

/**
 * @param dir fixtures 目录
 * @returns {{ fixtures: Array<{module:string, file:string, apis:Array}>, errors: string[] }}
 */
function loadFixtures(dir) {
  const errors = [];
  const fixtures = [];
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { fixtures, errors: [`fixtures 目录不存在或不可读: ${dir}`] };
  }
  if (files.length === 0) {
    errors.push(`fixtures 目录下没有任何 .json 文件: ${dir}`);
    return { fixtures, errors };
  }
  for (const file of files) {
    const full = path.join(dir, file);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (e) {
      errors.push(`${file}: 读取失败 — ${e.message}`);
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 剥 BOM（Windows 记事本存 UTF-8 常带）
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      errors.push(`${file}: JSON 解析失败 — ${e.message}`);
      continue;
    }
    // 模块名 = 文件名（唯一标识用文件名：天然唯一，复制文件必然改名；json 里的 module 字段废弃，写了也忽略）
    const module = path.basename(file, '.json');
    if (!data || !Array.isArray(data.apis) || data.apis.length === 0) {
      errors.push(`${file}: 缺少非空 apis 数组`);
      continue;
    }
    const names = new Set();
    const apis = [];
    let moduleOk = true;
    data.apis.forEach((api, i) => {
      if (!validateApi(api, file, i, errors)) { moduleOk = false; return; }
      if (names.has(api.name)) { errors.push(`${file}: 接口 name 重复 — ${api.name}`); moduleOk = false; return; }
      names.add(api.name);
      apis.push({
        ...api,
        // 平铺给下游（请求/报告用 api.method、api.path），method 统一大写
        method: api.newApi.method.toUpperCase(),
        path: api.newApi.path,
        oldApi: { method: api.oldApi.method.toUpperCase(), path: api.oldApi.path },
        module,
        file, // 来源 json 文件名，报告/控制台标识用
      });
    });
    if (moduleOk) fixtures.push({ module, file, apis });
  }
  return { fixtures, errors };
}

module.exports = { loadFixtures };
