import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'Mouse — 網頁行為透視',
    description: '完整列出網頁做了什麼——每一次請求、每一個監聽、每一次存取，你都看得到',
    permissions: ['activeTab', 'sidePanel', 'webNavigation', 'webRequest', 'webRequestBlocking'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Mouse',
    },
    sidebar_action: {
      default_panel: 'sidebar.html',
      default_title: 'Mouse Behavior Tracker',
    },
    side_panel: {
      default_path: 'sidebar.html',
    },
    web_accessible_resources: [
      {
        resources: ['injected.js'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
