'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadDotEnv } = require('../lib/dotenv');

function withTempEnvFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content, 'utf8');
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('从 .env 读取键值并注入 process.env（支持注释/空行/引号/BOM）', () => {
  delete process.env.DOTENV_TEST_A;
  delete process.env.DOTENV_TEST_B;
  withTempEnvFile('﻿# 注释行\n\nDOTENV_TEST_A = abc123\nDOTENV_TEST_B="x y"\n坏行没有等号\n', (file) => {
    loadDotEnv(file);
    assert.equal(process.env.DOTENV_TEST_A, 'abc123');
    assert.equal(process.env.DOTENV_TEST_B, 'x y');
  });
  delete process.env.DOTENV_TEST_A;
  delete process.env.DOTENV_TEST_B;
});

test('shell 里已存在的环境变量不被 .env 覆盖', () => {
  process.env.DOTENV_TEST_C = 'shell-value';
  withTempEnvFile('DOTENV_TEST_C=file-value\n', (file) => {
    loadDotEnv(file);
    assert.equal(process.env.DOTENV_TEST_C, 'shell-value');
  });
  delete process.env.DOTENV_TEST_C;
});

test('.env 不存在时静默返回 0', () => {
  assert.equal(loadDotEnv(path.join(os.tmpdir(), 'no-such-env-file-xyz-123')), 0);
});
