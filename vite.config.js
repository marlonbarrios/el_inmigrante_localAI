import { defineConfig } from 'vite';

// Browser requests go to /ollama/*, and Vite forwards them to the local Ollama server.
// That avoids CORS and keeps the model on this machine.
const ollamaTarget = 'http://127.0.0.1:11434';

const ollamaProxy = {
  '/ollama': {
    target: ollamaTarget,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/ollama/, ''),
  },
};

export default defineConfig({
  server: {
    proxy: ollamaProxy,
  },
  preview: {
    proxy: ollamaProxy,
  },
});
