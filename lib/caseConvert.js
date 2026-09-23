'use strict';

/**
 * PascalCase → camelCase 递归转换器。
 *
 * 默认规则：首字母小写，其余原样保留（无损规则）。
 * 缩写词（UserID / URL / IDCard）不做"智能猜测"——猜错是静默错误。
 * 猜不中时对比报告会出现 missing + added 成对差异，再由人工用 keyOverrides 消除。
 *
 * overrides 优先级（调用方合并后传入）：接口级 keyOverrides > config.globalKeyOverrides > 默认规则。
 * overrides 以"老接口原始 key"整词匹配，任意嵌套层级生效。
 */

function convertKey(key, overrides) {
  if (overrides && Object.hasOwn(overrides, key)) return overrides[key];
  return key.charAt(0).toLowerCase() + key.slice(1); // 非字母开头（_id、2fa）天然 no-op
}

function walk(node, overrides, warnings, path) {
  if (Array.isArray(node)) {
    return node.map((item, i) => walk(item, overrides, warnings, `${path}[${i}]`));
  }
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const next = convertKey(key, overrides);
      const childPath = path ? `${path}.${next}` : next;
      if (Object.hasOwn(out, next)) {
        // 例如 UserID 与 UserId 同时存在，转换后撞 key——绝不静默覆盖，记录告警并保留先出现者
        warnings.push({ type: 'key-collision', path: childPath, from: key });
        continue;
      }
      out[next] = walk(value, overrides, warnings, childPath);
    }
    return out;
  }
  return node; // 原始值（null / string / number / boolean）原样返回，value 永不触碰
}

/**
 * 递归把对象/数组的所有 key 转成小驼峰。
 * @param {any} node 老接口数据（大驼峰）
 * @param {Object} [overrides] 例外映射：老原始 key → 新实际 key
 * @returns {{ value: any, warnings: Array<{type:string, path:string, from:string}> }}
 */
function toCamelKeys(node, overrides = {}) {
  const warnings = [];
  return { value: walk(node, overrides, warnings, ''), warnings };
}

module.exports = { convertKey, toCamelKeys };
