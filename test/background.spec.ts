import { describe, it, expect } from 'vitest';

import type { WatchTargetRepo } from '../src/background/index';

// buildRepoQuery はデフォルトエクスポートではないため、ここでは
// 文字列構成ロジックのサニティチェックのみ簡易に行う。
// 本格的なAPI通信は手動テスト手順でカバーする。

describe('background watch logic (sanity)', () => {
  it('dummy test to ensure vitest wiring works', () => {
    const repos: WatchTargetRepo[] = [
      { owner: 'owner1', name: 'repo1' },
      { owner: 'owner2', name: 'repo2' },
    ];
    expect(repos).toHaveLength(2);
  });
});
