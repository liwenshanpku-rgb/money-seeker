// 用假的 fetch 验证网页提交 AI 点评请求的流程
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubCoach, guessRepo } from '../web/js/github.js';

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = url.replace('https://api.github.com/repos/o/r', '').split('?')[0];
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    const h = routes[`${method} ${path}`] ?? routes[`${method} *`];
    const [status, body] = typeof h === 'function' ? h() : h || [404, {}];
    return { status, ok: status < 300, json: async () => body };
  };
  return calls;
}

test('guessRepo 从 GitHub Pages 地址推断仓库', () => {
  assert.equal(guessRepo({ hostname: 'alice.github.io', pathname: '/money-seeker/' }), 'alice/money-seeker');
  assert.equal(guessRepo({ hostname: 'localhost', pathname: '/' }), '');
});

test('首次提交会创建孤儿数据分支、上传请求并触发工作流', async () => {
  const calls = mockFetch({
    'POST /git/trees': [201, { sha: 'tree1' }],
    'POST /git/commits': [201, { sha: 'c1' }],
    'POST /git/refs': [201, {}],
    'PUT *': [201, {}],
    'POST /dispatches': [204, null],
  });
  const gh = new GitHubCoach('o/r', 'tok');
  const id = await gh.submit({ note: '右曲', images: [] });
  assert.match(id, /^\d{14}-[a-z0-9]+$/);
  const seq = calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(seq, [
    'GET /git/ref/heads/swing-coach', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs',
    `PUT /contents/requests/${id}.json`, 'POST /dispatches',
  ]);
  assert.deepEqual(calls[2].body.parents, []);
  const put = calls[4].body;
  assert.equal(put.branch, 'swing-coach');
  const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(put.content), (c) => c.charCodeAt(0))));
  assert.equal(decoded.note, '右曲');
  assert.deepEqual(calls[5].body, { event_type: 'swing-coach', client_payload: { id } });
});

test('读取点评与错误', async () => {
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  mockFetch({ 'GET /contents/reviews/x1.md': [200, { content: b64('## 总体评价\n很好') }] });
  const gh = new GitHubCoach('o/r', 'tok');
  assert.deepEqual(await gh.check('x1'), { done: true, text: '## 总体评价\n很好' });
  mockFetch({ 'GET /contents/errors/x2.txt': [200, { content: b64('失败了\n') }] });
  assert.deepEqual(await gh.check('x2'), { done: true, error: '失败了' });
  mockFetch({});
  assert.deepEqual(await gh.check('x3'), { done: false });
});

test('token 无效时给出明确错误', async () => {
  mockFetch({ 'GET *': [401, { message: 'Bad credentials' }] });
  await assert.rejects(new GitHubCoach('o/r', 'bad').check('x'), /token 无效/);
});
