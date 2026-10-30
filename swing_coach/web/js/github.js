// 通过 GitHub API 把 AI 点评请求推到数据分支，并触发 Claude Code 工作流（使用订阅额度，不走 API 计费）。
// 需要一个只授权本仓库的 fine-grained token（Contents: Read and write）。token 只保存在本机浏览器。

export const DATA_BRANCH = 'swing-coach';
const API = 'https://api.github.com';

// 部署在 <owner>.github.io/<repo>/ 时自动推断仓库
export function guessRepo(loc = window.location) {
  const m = loc.hostname.match(/^([^.]+)\.github\.io$/i);
  const seg = loc.pathname.split('/').filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : '';
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubCoach {
  constructor(repo, token) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('仓库格式应为 owner/repo');
    if (!token) throw new Error('请先填写 GitHub token');
    this.repo = repo;
    this.token = token;
  }

  async call(method, path, body) {
    const res = await fetch(`${API}/repos/${this.repo}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 404) return null;
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error('GitHub token 无效或已过期');
      if (res.status === 403) throw new Error(`GitHub 拒绝了请求：${data.message || ''}（token 需要本仓库的 Contents 读写权限）`);
      throw new Error(`GitHub API 错误 ${res.status}：${data.message || ''}`);
    }
    return data;
  }

  // 数据分支不存在时建一个只含说明文件的孤儿分支
  async ensureBranch() {
    if (await this.call('GET', `/git/ref/heads/${DATA_BRANCH}`)) return;
    const tree = await this.call('POST', '/git/trees', {
      tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: '# 挥杆教练数据分支\n\n网页提交的 AI 点评请求与结果，由 swing-coach 工作流自动维护。\n' }],
    });
    const commit = await this.call('POST', '/git/commits', { message: 'Init swing coach data branch', tree: tree.sha, parents: [] });
    await this.call('POST', '/git/refs', { ref: `refs/heads/${DATA_BRANCH}`, sha: commit.sha });
  }

  async submit(payload) {
    const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.ensureBranch();
    await this.call('PUT', `/contents/requests/${id}.json`, {
      message: `Swing coach request ${id}`,
      content: utf8ToBase64(JSON.stringify({ id, ...payload })),
      branch: DATA_BRANCH,
    });
    await this.call('POST', '/dispatches', { event_type: 'swing-coach', client_payload: { id } });
    return id;
  }

  async readFile(path) {
    const f = await this.call('GET', `/contents/${path}?ref=${DATA_BRANCH}&t=${Date.now()}`);
    return f && f.content ? base64ToUtf8(f.content) : null;
  }

  // 返回 {done, text} 或 {done, error}，未完成返回 {done: false}
  async check(id) {
    const review = await this.readFile(`reviews/${id}.md`);
    if (review) return { done: true, text: review };
    const error = await this.readFile(`errors/${id}.txt`);
    if (error) return { done: true, error: error.trim() };
    return { done: false };
  }

  async waitFor(id, { interval = 15000, timeout = 20 * 60 * 1000, onTick } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = await this.check(id);
      if (r.done) return r;
      onTick?.(Math.round((Date.now() - t0) / 1000));
      await new Promise((ok) => setTimeout(ok, interval));
    }
    return { done: false };
  }
}

// localStorage 可能不可用（隐私模式等），读写都要包 try
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 忽略 */ } },
};
