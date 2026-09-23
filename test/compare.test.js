'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareResponses } = require('../lib/compare');

test('纯改名（仅大小写）无差异', () => {
  const { diffs } = compareResponses(
    { Code: 0, Data: { UserName: 'a', Tags: ['x'], Addr: { City: 'hz' } } },
    { code: 0, data: { userName: 'a', tags: ['x'], addr: { city: 'hz' } } },
  );
  assert.equal(diffs.length, 0);
});

test('缺字段 missing-in-new', () => {
  const { diffs } = compareResponses({ Data: { Name: 'a', Age: 1 } }, { data: { name: 'a' } });
  assert.deepEqual(diffs.map((d) => `${d.type} ${d.path}`), ['missing-in-new data.age']);
});

test('新增字段默认 fail，addedIsFail:false 降级为 info（不进差异清单）', () => {
  const a = compareResponses({ Code: 0 }, { code: 0, traceId: 'x' });
  assert.equal(a.diffs[0].type, 'added-in-new');
  assert.equal(a.diffs[0].level, 'fail');
  const b = compareResponses({ Code: 0 }, { code: 0, traceId: 'x' }, { addedIsFail: false });
  assert.equal(b.diffs.length, 0);
  assert.equal(b.infos.length, 1);
  assert.equal(b.infos[0].type, 'added-in-new');
});

test('类型变化 type-mismatch', () => {
  const { diffs } = compareResponses({ Data: { Total: 3 } }, { data: { total: '3' } });
  assert.equal(diffs[0].type, 'type-mismatch');
  assert.equal(diffs[0].oldType, 'number');
  assert.equal(diffs[0].newType, 'string');
});

test('新侧忘了改大小写 → missing + added 成对暴露', () => {
  const { diffs } = compareResponses({ Data: { UserName: 'a' } }, { data: { UserName: 'a' } });
  const set = diffs.map((d) => `${d.type} ${d.path}`).sort();
  assert.deepEqual(set, ['added-in-new data.UserName', 'missing-in-new data.userName']);
});

test('null 非对称策略：老 null 跳过；老有值新 null 算违约', () => {
  const a = compareResponses({ A: null }, { a: 'x' });
  assert.equal(a.diffs.length, 0);
  assert.equal(a.infos[0].type, 'null-skip');
  const b = compareResponses({ A: 'x' }, { a: null });
  assert.equal(b.diffs[0].type, 'type-mismatch');
  assert.equal(b.diffs[0].newType, 'null');
});

test('null lax / strict 策略', () => {
  const lax = compareResponses({ A: 'x' }, { a: null }, { nullPolicy: 'lax' });
  assert.equal(lax.diffs.length, 0);
  const strict = compareResponses({ A: null }, { a: 'x' }, { nullPolicy: 'strict' });
  assert.equal(strict.diffs.length, 1);
});

test('数组归并：异构行不误报', () => {
  const { diffs } = compareResponses(
    { List: [{ A: null, B: 1 }, { A: 'x' }] },
    { list: [{ a: 'y', b: 2 }] },
  );
  assert.equal(diffs.length, 0);
});

test('数组归并：部分行出现的 key 缺失时降级为提示', () => {
  const r = compareResponses({ List: [{ A: 1, B: 1 }, { A: 2 }] }, { list: [{ a: 1 }] });
  assert.equal(r.diffs.length, 0);
  assert.equal(r.infos.some((i) => i.type === 'optional-key-missing' && i.path === 'list[].b'), true);
});

test('数组归并：全行都有的 key 缺失算差异', () => {
  const { diffs } = compareResponses({ List: [{ A: 1, B: 1 }] }, { list: [{ a: 1 }] });
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, 'missing-in-new');
  assert.equal(diffs[0].path, 'list[].b');
});

test('空数组：老空跳过；新空默认跳过，emptyArrayIsDiff 可收紧', () => {
  const a = compareResponses({ List: [] }, { list: [{ a: 1 }] });
  assert.equal(a.diffs.length, 0);
  assert.equal(a.infos[0].type, 'empty-array-skip');
  const b = compareResponses({ List: [{ A: 1 }] }, { list: [] });
  assert.equal(b.diffs.length, 0);
  const c = compareResponses({ List: [{ A: 1 }] }, { list: [] }, { emptyArrayIsDiff: true });
  assert.equal(c.diffs.length, 1);
  assert.equal(c.diffs[0].type, 'empty-array');
});

test('数组原始元素类型变化', () => {
  const { diffs } = compareResponses({ Tags: ['a'] }, { tags: [1] });
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, 'type-mismatch');
  assert.equal(diffs[0].path, 'tags[]');
});

test('数组元素种类变化（对象 ↔ 原始值）', () => {
  const { diffs } = compareResponses({ List: [{ A: 1 }] }, { list: ['x'] });
  assert.equal(diffs.some((d) => d.type === 'type-mismatch' && d.path === 'list[]'), true);
});

test('ignorePaths 排除波动字段', () => {
  const { diffs } = compareResponses(
    { Code: 0, Message: 'x' },
    { code: 0, message: 123 },
    { ignorePaths: ['message'] },
  );
  assert.equal(diffs.length, 0);
});

test('keyOverrides 在对比中生效（不配则成对暴露缩写词差异）', () => {
  const old = { Data: { OrderID: 'A1' } };
  const nw = { data: { orderId: 'A1' } };
  assert.equal(compareResponses(old, nw).diffs.length, 2);
  assert.equal(compareResponses(old, nw, { overrides: { OrderID: 'orderId' } }).diffs.length, 0);
});

test('strictNumber 只产 hint 不算差异', () => {
  const r = compareResponses({ Total: 3 }, { total: 3.5 }, { strictNumber: true });
  assert.equal(r.diffs.length, 0);
  assert.equal(r.infos[0].type, 'number-int-float-hint');
});

test('diff 同时带规范化路径与老接口原始路径', () => {
  const { diffs } = compareResponses({ Data: { List: [{ SkuId: 1, Num: 2 }] } }, { data: { list: [{ skuId: 1 }] } });
  assert.equal(diffs[0].path, 'data.list[].num');
  assert.equal(diffs[0].origPath, 'Data.List[].Num');
});

test('字段映射表 fields：逐节点记录老新路径与状态（文档序）', () => {
  const { fields } = compareResponses(
    { Code: 0, Data: { Name: 'a', Age: 1, Gone: 'x', Tags: ['x'] } },
    { code: 0, data: { name: 'a', age: '1', tags: ['x'], extra: true } },
  );
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.equal(byPath['code'].status, 'match');
  assert.equal(byPath['data'].status, 'match');
  assert.equal(byPath['data.name'].status, 'match');
  assert.equal(byPath['data.name'].origPath, 'Data.Name');
  assert.equal(byPath['data.age'].status, 'type-mismatch');
  assert.equal(byPath['data.tags'].status, 'match');
  assert.equal(byPath['data.gone'].status, 'missing');
  assert.equal(byPath['data.gone'].origPath, 'Data.Gone');
  assert.equal(byPath['data.gone'].newType, '<缺失>');
  assert.equal(byPath['data.extra'].status, 'added');
  assert.equal(byPath['data.extra'].oldType, '<无>');
});
