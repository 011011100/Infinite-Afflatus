import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    plugins: [
      react(),
      {
        name: 'development-content-security-policy',
        apply: 'serve',
        // React Refresh uses an inline preamble; packaged pages keep the stricter CSP.
        transformIndexHtml: (html) =>
          html
            .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
            .replace(
              "connect-src 'self';",
              "connect-src 'self' ws://127.0.0.1:5173;",
            ),
      },
    ],
  },
});
