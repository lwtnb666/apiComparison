'use strict';

const { convertKey } = require('./caseConvert');

/**
 * 深度结构 + 类型对比器。
 *
 * - 老侧 key 边走边转小驼峰（含 overrides），新侧 key 原样使用——
 *   这样后端"忘了改大小写"会暴露为 missing + added 成对差异，而不是被静默放过。
 * - value 只比类型不比具体值（真实请求每次返回值不同）。
 * - 差异级别：fail（算差异）/ warn（警告，不影响 PASS）/ info（提示，进 infos 不进 diffs）。
 */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'object' | 'string' | 'number' | 'boolean' | 'undefined'
}

function joinPath(path, key) {
  return path ? `${path}.${key}` : String(key);
}

function push(out, entry) {
  out[entry.level === 'info' ? 'infos' : 'diffs'].push(entry);
}

// ---- 数组归并：把数组所有元素合成一个"元素 schema" ----

// 代表值归并：非 null 优先（保留更多类型信息）；同构对象深合并；同构数组拼接（元素稍后再次归并）
function mergeRepresentative(acc, v) {
  if (acc === undefined) return v;
  if (acc === null && v !== null) return v;
  const ta = typeOf(acc);
  if (ta === 'object' && typeOf(v) === 'object') {
    const out = { ...acc };
    for (const [k, val] of Object.entries(v)) {
      out[k] = Object.hasOwn(out, k) ? mergeRepresentative(out[k], val) : val;
    }
    return out;
  }
  if (ta === 'array' && typeOf(v) === 'array') return acc.concat(v);
  return acc; // 类型冲突时保留先出现的非 null 值（异构行属于数据噪音，不报）
}

/**
 * 分析数组元素形状。
 * @param arr 数组
 * @param convert key 转换函数：老侧传 (k)=>convertKey(k,overrides)，新侧传 (k)=>k（原样）
 * @returns {{ objCount:number, primTypes:Set<string>, node:object,
 *             origKeys:Map<string,string>, partial:Set<string> }}
 *   node     —— 所有对象行的 key 并集 + 代表值（顶层 key 已转换，嵌套层 key 保持原样，递归时再转）
 *   origKeys —— 顶层转换后 key → 首次出现的原始 key（用于报告"原始路径"）
 *   partial  —— 未在全部对象行中出现的 key（视为可选字段，missing 时降级为 info）
 */
function analyzeArray(arr, convert) {
  const primTypes = new Set();
  let objCount = 0;
  const node = {};
  const origKeys = new Map();
  const seen = {};
  for (const el of arr) {
    if (typeOf(el) !== 'object') {
      primTypes.add(typeOf(el)); // 含 'null' 与 'array'（数组套数组的罕见情形只做类型层面比对）
      continue;
    }
    objCount++;
    for (const [rawKey, value] of Object.entries(el)) {
      const key = convert(rawKey);
      seen[key] = (seen[key] || 0) + 1;
      if (!origKeys.has(key)) origKeys.set(key, rawKey);
      node[key] = Object.hasOwn(node, key) ? mergeRepresentative(node[key], value) : value;
    }
  }
  const partial = new Set(Object.keys(seen).filter((k) => seen[k] < objCount));
  return { objCount, primTypes, node, origKeys, partial };
}

/**
 * @param level.presetOldKeys 老侧 key 已预先转换（数组 schema 递归时）：Map<转换后key, 原始key>
 * @param level.oldPartial    老侧可选 key 集合（数组异构行场景），missing 时降级为 info
 */
function compareNodes(oldV, newV, path, origPath, out, opts, level) {
  if (path && opts.ignoreSet.has(path)) return;

  const tOld = typeOf(oldV);
  const tNew = typeOf(newV);

  // 字段映射表：每个访问到的节点留一行（根节点 path 为空除外），状态与 diffs/infos 同步
  const row = (status, extra = {}) => {
    if (path) out.fields.push({ path, origPath, oldType: tOld, newType: tNew, status, ...extra });
  };

  // null 策略：老=null 不含类型信息（抓包时恰好为空），默认跳过记 info；
  // 老=非null、新=null 是"有值变恒空"，典型违约形态，默认算 type-mismatch。
  if (tOld === 'null' || tNew === 'null') {
    if (tOld === 'null' && tNew === 'null') { row('match'); return; }
    if (tOld === 'null') {
      row(opts.nullPolicy === 'strict' ? 'type-mismatch' : 'null-skip');
      if (opts.nullPolicy === 'strict') {
        push(out, { level: 'fail', type: 'type-mismatch', path, origPath, oldType: 'null', newType: tNew });
      } else {
        push(out, { level: 'info', type: 'null-skip', path, origPath, oldType: 'null', newType: tNew, note: '老数据为 null，无法判定类型' });
      }
      return;
    }
    row(opts.nullPolicy === 'lax' ? 'null-skip' : 'type-mismatch');
    if (opts.nullPolicy === 'lax') {
      push(out, { level: 'info', type: 'null-skip', path, origPath, oldType: tOld, newType: 'null', note: '新数据为 null（lax 策略跳过）' });
    } else {
      push(out, { level: 'fail', type: 'type-mismatch', path, origPath, oldType: tOld, newType: 'null' });
    }
    return;
  }

  if (tOld !== tNew) {
    row('type-mismatch');
    push(out, { level: 'fail', type: 'type-mismatch', path, origPath, oldType: tOld, newType: tNew });
    return;
  }

  if (tOld === 'object') {
    row('match');
    // 老侧展开为 [{key(转换后), origKey, value}]；preset 模式 key 已转换好
    const oldEntries = [];
    if (level.presetOldKeys) {
      for (const [key, origKey] of level.presetOldKeys) {
        oldEntries.push({ key, origKey, value: oldV[key] });
      }
    } else {
      const seenConverted = new Set();
      for (const [origKey, value] of Object.entries(oldV)) {
        const key = convertKey(origKey, opts.overrides);
        if (seenConverted.has(key)) {
          push(out, { level: 'info', type: 'key-collision', path: joinPath(path, key), origPath: joinPath(origPath, origKey), note: '转换后 key 冲突，仅保留先出现者' });
          continue;
        }
        seenConverted.add(key);
        oldEntries.push({ key, origKey, value });
      }
    }
    const oldByKey = new Map(oldEntries.map((e) => [e.key, e]));

    for (const e of oldEntries) {
      const childPath = joinPath(path, e.key);
      const childOrig = joinPath(origPath, e.origKey);
      if (opts.ignoreSet.has(childPath)) continue;
      if (!Object.hasOwn(newV, e.key)) {
        const optional = !!(level.oldPartial && level.oldPartial.has(e.key));
        if (optional) {
          push(out, { level: 'info', type: 'optional-key-missing', path: childPath, origPath: childOrig, oldType: typeOf(e.value), newType: '<缺失>', note: '老数据该字段仅部分行出现（可选字段），缺失降级为提示' });
        } else {
          push(out, { level: 'fail', type: 'missing-in-new', path: childPath, origPath: childOrig, oldType: typeOf(e.value), newType: '<缺失>' });
        }
        out.fields.push({ path: childPath, origPath: childOrig, oldType: typeOf(e.value), newType: '<缺失>', status: optional ? 'optional-missing' : 'missing' });
        continue;
      }
      compareNodes(e.value, newV[e.key], childPath, childOrig, out, opts, {});
    }
    for (const key of Object.keys(newV)) {
      if (oldByKey.has(key)) continue;
      const childPath = joinPath(path, key);
      if (opts.ignoreSet.has(childPath)) continue;
      const addedLevel = opts.addedIsFail ? 'fail' : 'info'; // 包含式：多给字段不挂红、不进差异清单，仅留 info 存档
      push(out, {
        level: addedLevel,
        type: 'added-in-new', path: childPath, origPath: '<新增>',
        oldType: '<无>', newType: typeOf(newV[key]),
        ...(addedLevel === 'info' ? { note: '新接口多给的字段，不视为违约' } : {}),
      });
      out.fields.push({ path: childPath, origPath: '<新增>', oldType: '<无>', newType: typeOf(newV[key]), status: 'added' });
    }
    return;
  }

  if (tOld === 'array') {
    if (oldV.length === 0) {
      row('empty-skip');
      push(out, { level: 'info', type: 'empty-array-skip', path, origPath, note: '老数据为空数组，无法推断元素结构' });
      return;
    }
    if (newV.length === 0) {
      row(opts.emptyArrayIsDiff ? 'empty-diff' : 'empty-skip');
      if (opts.emptyArrayIsDiff) {
        push(out, { level: 'fail', type: 'empty-array', path, origPath, oldType: `array(${oldV.length})`, newType: 'array(0)' });
      } else {
        push(out, { level: 'info', type: 'empty-array-skip', path, origPath, note: '新数据为空结果集（数据相关，非契约变化）' });
      }
      return;
    }
    row('match');
    const a = analyzeArray(oldV, (k) => convertKey(k, opts.overrides));
    const b = analyzeArray(newV, (k) => k); // 新侧 key 原样
    const elPath = `${path}[]`;
    const elOrig = `${origPath}[]`;

    // 元素种类变化（对象 ↔ 原始值）
    if (a.objCount > 0 && b.objCount === 0) {
      push(out, { level: 'fail', type: 'type-mismatch', path: elPath, origPath: elOrig, oldType: 'object', newType: [...b.primTypes].join('|') || 'object(空行)' });
      out.fields.push({ path: elPath, origPath: elOrig, oldType: 'object', newType: [...b.primTypes].join('|') || 'object(空行)', status: 'type-mismatch' });
    } else if (a.objCount === 0 && b.objCount > 0) {
      push(out, { level: 'fail', type: 'type-mismatch', path: elPath, origPath: elOrig, oldType: [...a.primTypes].join('|') || 'object(空行)', newType: 'object' });
      out.fields.push({ path: elPath, origPath: elOrig, oldType: [...a.primTypes].join('|') || 'object(空行)', newType: 'object', status: 'type-mismatch' });
    }
    // 原始元素类型集合：老有新无 → 差异；新有老无 → 提示
    for (const t of a.primTypes) {
      if (!b.primTypes.has(t)) {
        push(out, { level: 'fail', type: 'type-mismatch', path: elPath, origPath: elOrig, oldType: t, newType: '<缺失>' });
        out.fields.push({ path: elPath, origPath: elOrig, oldType: t, newType: '<缺失>', status: 'type-mismatch' });
      }
    }
    for (const t of b.primTypes) {
      if (!a.primTypes.has(t)) {
        push(out, { level: 'info', type: 'element-type-added', path: elPath, origPath: elOrig, oldType: '<无>', newType: t });
        out.fields.push({ path: elPath, origPath: elOrig, oldType: '<无>', newType: t, status: 'added' });
      }
    }
    // 对象元素 schema 递归对比（老侧顶层 key 已转换 → preset 模式）
    if (a.objCount > 0 && b.objCount > 0) {
      compareNodes(a.node, b.node, elPath, elOrig, out, opts, { presetOldKeys: a.origKeys, oldPartial: a.partial });
    }
    return;
  }

  // 原始值：类型相同即通过（不比具体值）；strictNumber 时 int/float 差异只产 hint
  row('match');
  if (tOld === 'number' && opts.strictNumber) {
    const oldInt = Number.isInteger(oldV);
    const newInt = Number.isInteger(newV);
    if (oldInt !== newInt) {
      push(out, { level: 'info', type: 'number-int-float-hint', path, origPath, oldType: oldInt ? 'integer' : 'float', newType: newInt ? 'integer' : 'float' });
    }
  }
}

/**
 * 对比老响应（人工维护，大驼峰原样）与新接口实际返回。
 * @param oldResponse 人工维护的老响应
 * @param newResponse 新接口返回（已 JSON.parse）
 * @param [opts.overrides]    key 例外映射（老原始 key → 新实际 key）
 * @param [opts.ignorePaths]  排除的规范化路径（如 ['message', 'data.traceId']，数组层用 [] 如 'data.list[].traceId'）
 * @param [opts.nullPolicy]   'asymmetric'（默认）| 'lax' | 'strict'
 * @param [opts.strictNumber] int/float 细分（仅 hint，不算差异）
 * @param [opts.emptyArrayIsDiff] 新侧空数组是否算差异（默认否）
 * @param [opts.addedIsFail]  新增字段是否算差异（默认是，false 降级为 info 仅存档，不进差异清单）
 * @returns {{ diffs: Array, infos: Array, fields: Array }}
 *   fields —— 全量字段映射行（文档序，含一致行）：{ path, origPath, oldType, newType, status }
 *   status: match / missing / optional-missing / added / type-mismatch / null-skip / empty-skip / empty-diff
 */
function compareResponses(oldResponse, newResponse, opts = {}) {
  const out = { diffs: [], infos: [], fields: [] }; // fields = 全量字段映射行（文档序），供 MD 报告"字段一一对应"
  const options = {
    overrides: opts.overrides || {},
    ignoreSet: new Set(opts.ignorePaths || []),
    nullPolicy: opts.nullPolicy || 'asymmetric',
    strictNumber: !!opts.strictNumber,
    emptyArrayIsDiff: !!opts.emptyArrayIsDiff,
    addedIsFail: opts.addedIsFail !== false,
  };
  compareNodes(oldResponse, newResponse, '', '', out, options, {});
  const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0); // 排序稳定，多次运行报告可 diff
  out.diffs.sort(byPath);
  out.infos.sort(byPath);
  return out;
}

module.exports = { compareResponses, typeOf };
