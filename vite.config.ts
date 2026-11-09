import { defineConfig } from 'vite';
// Relative base so the built game runs from any folder, a static host, or a Tauri wrapper.
export default defineConfig({ base: './' });
