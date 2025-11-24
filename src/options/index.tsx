import React from 'react';
import ReactDOM from 'react-dom/client';
import OptionsApp from './optionsApp';

/**
 * オプションページ用の React アプリケーションのエントリポイント。
 * `root` 要素に `OptionsApp` コンポーネントをマウントする。
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>,
);
