// Magpie's existing OpenCode-compatible authentication hook acts as a
// control-console launcher. No Magpie Page Bridge or Go binary is required.
import { startConsole } from './src/console.mjs';

let instance;
let pending;
function ensureConsole(options) {
  if (instance) return Promise.resolve(instance);
  if (!pending) pending = startConsole(options).then(
    server => (instance = server),
    error => { pending = undefined; throw error; },
  );
  return pending;
}

export default {
  id: 'magpie-lm-detector-external',
  server: async (_input, options = {}) => ({
    auth: {
      provider: 'magpie-lm-detector-external',
      methods: [{
        type: 'oauth',
        label: '打开模型指纹检测控制台 / Open fingerprint console',
        async authorize() {
          const consoleServer = await ensureConsole(options);
          const url = consoleServer.issueURL();
          return {
            url,
            instructions: '请在浏览器打开完整链接。一次性链接 10 分钟内有效，首次打开后即失效；本入口不需要供应商授权码。',
            method: 'code',
            callback: async () => ({ type: 'failed' }),
          };
        },
      }],
      async loader() { await ensureConsole(options); return {}; },
    },
    async config(config) {
      // Avoid waiting on Magpie's own Gateway while it is still starting.
      await ensureConsole(options);
      config.provider ??= {};
      config.provider['magpie-lm-detector-external'] = {
        name: 'LM Detector (console)', models: {},
      };
    },
  }),
};
