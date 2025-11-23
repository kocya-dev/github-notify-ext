import React, { useEffect, useState } from 'react';

type WatchTargetRepo = {
  owner: string;
  name: string;
};

type SettingsForm = {
  pat: string;
  reposText: string;
  intervalMinutes: number;
  enableNewItems: boolean;
  enableMentions: boolean;
  enableMentionThreads: boolean;
  enableAssigneeComments: boolean;
};

const DEFAULT_INTERVAL_MINUTES = 5;

const OptionsApp: React.FC = () => {
  const [form, setForm] = useState<SettingsForm>({
    pat: '',
    reposText: '',
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    enableNewItems: true,
    enableMentions: true,
    enableMentionThreads: true,
    enableAssigneeComments: true,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.sync.get(
      {
        pat: '',
        repos: [],
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        enableNewItems: true,
        enableMentions: true,
        enableMentionThreads: true,
        enableAssigneeComments: true,
      },
      (items: any) => {
        const repos = Array.isArray(items.repos) ? (items.repos as WatchTargetRepo[]) : [];
        const reposText = repos.map((r) => `${r.owner}/${r.name}`).join('\n');
        setForm({
          pat: String(items.pat ?? ''),
          reposText,
          intervalMinutes: Number(items.intervalMinutes) || DEFAULT_INTERVAL_MINUTES,
          enableNewItems: Boolean(items.enableNewItems),
          enableMentions: Boolean(items.enableMentions),
          enableMentionThreads: Boolean(items.enableMentionThreads),
          enableAssigneeComments: Boolean(items.enableAssigneeComments),
        });
      },
    );
  }, []);

  const handleChange = (patch: Partial<SettingsForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const parseRepos = (text: string): WatchTargetRepo[] => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const result: WatchTargetRepo[] = [];
    for (const line of lines) {
      const [owner, name] = line.split('/');
      if (!owner || !name) continue;
      result.push({ owner, name });
    }
    return result;
  };

  const handleSubmit: React.FormEventHandler = (e) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveMessage(null);

    const repos = parseRepos(form.reposText);

    chrome.storage.sync.set(
      {
        pat: form.pat,
        repos,
        intervalMinutes: form.intervalMinutes,
        enableNewItems: form.enableNewItems,
        enableMentions: form.enableMentions,
        enableMentionThreads: form.enableMentionThreads,
        enableAssigneeComments: form.enableAssigneeComments,
      },
      () => {
        setIsSaving(false);
        setSaveMessage('保存しました');
        setTimeout(() => setSaveMessage(null), 2000);
      },
    );
  };

  return (
    <div
      style={{
        maxWidth: '640px',
        margin: '0 auto',
        padding: '16px',
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: '13px',
      }}
    >
      <h1 style={{ fontSize: '18px', marginBottom: '12px' }}>GitHub Notify 設定</h1>
      <form onSubmit={handleSubmit}>
        <section style={{ marginBottom: '16px' }}>
          <h2 style={{ fontSize: '14px', margin: '8px 0' }}>API キー (PAT)</h2>
          <p style={{ margin: '4px 0', color: '#555' }}>
            GitHub Personal Access Token を入力してください。
          </p>
          <input
            type="password"
            value={form.pat}
            onChange={(e) => handleChange({ pat: e.target.value })}
            style={{ width: '100%', padding: '6px', boxSizing: 'border-box' }}
          />
        </section>

        <section style={{ marginBottom: '16px' }}>
          <h2 style={{ fontSize: '14px', margin: '8px 0' }}>監視対象リポジトリ</h2>
          <p style={{ margin: '4px 0', color: '#555' }}>
            1 行に 1 リポジトリずつ、<code>owner/repo</code> 形式で入力してください。
          </p>
          <textarea
            value={form.reposText}
            onChange={(e) => handleChange({ reposText: e.target.value })}
            rows={6}
            style={{ width: '100%', padding: '6px', boxSizing: 'border-box', resize: 'vertical' }}
          />
        </section>

        <section style={{ marginBottom: '16px' }}>
          <h2 style={{ fontSize: '14px', margin: '8px 0' }}>監視間隔</h2>
          <p style={{ margin: '4px 0', color: '#555' }}>通知の検出間隔を分単位で指定します。</p>
          <input
            type="number"
            min={1}
            value={form.intervalMinutes}
            onChange={(e) => handleChange({ intervalMinutes: Number(e.target.value) || 1 })}
            style={{ width: '80px', padding: '4px' }}
          />{' '}
          分
        </section>

        <section style={{ marginBottom: '16px' }}>
          <h2 style={{ fontSize: '14px', margin: '8px 0' }}>通知種別</h2>
          <label style={{ display: 'block', margin: '4px 0' }}>
            <input
              type="checkbox"
              checked={form.enableNewItems}
              onChange={(e) => handleChange({ enableNewItems: e.target.checked })}
            />{' '}
            新着 PR/Issue
          </label>
          <label style={{ display: 'block', margin: '4px 0' }}>
            <input
              type="checkbox"
              checked={form.enableMentions}
              onChange={(e) => handleChange({ enableMentions: e.target.checked })}
            />{' '}
            自分へのメンション
          </label>
          <label style={{ display: 'block', margin: '4px 0' }}>
            <input
              type="checkbox"
              checked={form.enableMentionThreads}
              onChange={(e) => handleChange({ enableMentionThreads: e.target.checked })}
            />{' '}
            自分のメンションを含む会話
          </label>
          <label style={{ display: 'block', margin: '4px 0' }}>
            <input
              type="checkbox"
              checked={form.enableAssigneeComments}
              onChange={(e) => handleChange({ enableAssigneeComments: e.target.checked })}
            />{' '}
            自分が担当するチケットの会話
          </label>
        </section>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="submit"
            disabled={isSaving}
            style={{
              padding: '6px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: '#0969da',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            {isSaving ? '保存中...' : '保存'}
          </button>
          {saveMessage && <span style={{ color: '#1a7f37' }}>{saveMessage}</span>}
        </div>
      </form>
    </div>
  );
};

export default OptionsApp;
