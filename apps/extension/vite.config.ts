import { defineConfig } from "vite";
import { resolve } from "node:path";

const root = __dirname;
const alias = {
	"@repo/import": resolve(root, "../../packages/import"),
};

export default defineConfig(({ mode }) => {
	const isInject = mode === "inject";
	const isContent = mode === "content";
	const isBackground = mode === "background";
	const isWatch = process.argv.includes("--watch");
	const entry = isInject
		? "src/capture-inject.ts"
		: isContent
			? "src/content.ts"
			: isBackground
				? "src/background/index.ts"
				: "src/popup.ts";
	const outFile = isInject
		? "capture-inject.js"
		: isContent
			? "content.js"
			: isBackground
				? "background.js"
				: "popup.js";

	return {
		resolve: { alias },
		esbuild: {
			tsconfigRaw: {
				compilerOptions: {
					useDefineForClassFields: false,
					target: "ES2020",
				},
			},
		},
		build: {
			target: "es2020",
			outDir: "dist",
			emptyOutDir: isInject && !isWatch,
			lib: {
				entry: resolve(root, entry),
				formats: ["iife"],
				name: "bp",
				fileName: () => outFile,
			},
			rollupOptions: {
				output: {
					extend: true,
					inlineDynamicImports: true,
				},
			},
		},
	};
});
