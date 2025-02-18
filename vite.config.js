import { defineConfig } from 'vite';
import reactRefresh from '@vitejs/plugin-react-refresh';
import * as esbuild from 'esbuild';
import path from 'path';
import pkg from './package.json';

/**
 * Bundles vite worker modules during development into single scripts.
 * see: https://github.com/hms-dbmi/viv/pull/469#issuecomment-877276110
 * @returns {import('vite').Plugin}
 */
const bundleWebWorker = {
    name: 'bundle-web-worker',
    apply: 'serve', // plugin only applied with dev-server
    async transform(_, id) {
        if (/\?worker_file$/.test(id)) {
            // just use esbuild to bundle the worker dependencies
            const bundle = await esbuild.build({
                entryPoints: [id],
                inject: ['./src/alias/buffer-shim.js'],
                format: 'iife',
                bundle: true,
                write: false,
            });
            if (bundle.outputFiles.length !== 1) {
                throw new Error('Worker must be a single module.');
            }
            return bundle.outputFiles[0].text;
        }
    },
};

// We can't inject a global `Buffer` polyfill for the worker entrypoint using vite alone,
// so we reuse the `bundle-web-worker` plugin to inject the buffer shim during production.
const manualInlineWorker = {
    apply: 'build',
    async transform(code, id) {
        if (id.endsWith('bam-worker.js?worker&inline')) {
            const bundle = await bundleWebWorker.transform(code, id + '?worker_file');
            const base64 = Buffer.from(bundle).toString('base64');
            // https://github.com/vitejs/vite/blob/72cb33e947e7aa72d27ed0c5eacb2457d523dfbf/packages/vite/src/node/plugins/worker.ts#L78-L87
            return `const encodedJs = "${base64}";
const blob = typeof window !== "undefined" && window.Blob && new Blob([atob(encodedJs)], { type: "text/javascript;charset=utf-8" });
export default function() {
  const objURL = blob && (window.URL || window.webkitURL).createObjectURL(blob);
  try {
    return objURL ? new Worker(objURL) : new Worker("data:application/javascript;base64," + encodedJs, {type: "module"});
  } finally {
    objURL && (window.URL || window.webkitURL).revokeObjectURL(objURL);
  }
}`;
        }
    },
};

const alias = {
    'gosling.js': path.resolve(__dirname, './src/index.ts'),
    '@gosling.schema': path.resolve(__dirname, './src/core/gosling.schema'),
    '@higlass.schema': path.resolve(__dirname, './src/core/higlass.schema'),
    'zlib': path.resolve(__dirname, './src/alias/zlib.ts'),
    'uuid': path.resolve(__dirname, './node_modules/uuid/dist/esm-browser/index.js'),
};

const skipExt = new Set(['@gmod/bbi', 'uuid']);
const external = [
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.peerDependencies),
].filter((dep) => !skipExt.has(dep));

const esm = defineConfig({
    build: {
        outDir: 'dist',
        minify: false,
        target: 'es2018',
        sourcemap: true,
        lib: {
            entry: path.resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: 'gosling',
        },
        rollupOptions: { external },
    },
    resolve: { alias },
    plugins: [manualInlineWorker],
});

const dev = defineConfig({
    build: { outDir: 'build' },
    resolve: { alias },
    define: {
        'process.platform': 'undefined',
        'process.env.THREADS_WORKER_INIT_TIMEOUT': 'undefined',
    },
    plugins: [bundleWebWorker, manualInlineWorker],
});

export default ({ command, mode }) => {
    if (command === 'build' && mode === 'lib') return esm;
    if (mode === 'editor') {
        dev.plugins.push(reactRefresh());
    }
    return dev;
};
