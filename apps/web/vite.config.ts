import { defineConfig } from 'vite';

// BEAMDESK_SERVER_URL is baked into builds that run outside the server's origin
// (the desktop app), so end users never have to type a server address.
export default defineConfig({
  base: './',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  define: {
    __DEFAULT_SERVER__: JSON.stringify(process.env.BEAMDESK_SERVER_URL ?? ''),
    __DOWNLOAD_URL__: JSON.stringify(process.env.BEAMDESK_DOWNLOAD_URL ?? 'https://github.com/Safiullah-Rahu/BeamDesk/releases/latest'),
    // The browser version on a public website (GitHub Pages): phones open it to reach a home server.
    __WEB_APP_URL__: JSON.stringify(process.env.BEAMDESK_WEB_APP_URL ?? 'https://safiullah-rahu.github.io/BeamDesk/'),
    // Built for a static website, where no BeamDesk server answers at the page's own address.
    __STATIC_SITE__: JSON.stringify(process.env.BEAMDESK_STATIC_SITE === '1'),
  },
  resolve: {
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': 'http://localhost:8080',
    },
  },
});
