import esbuild from "esbuild";

export async function buildAdminUi() {
	const result = await esbuild.build({
		bundle: true,
		entryPoints: ["src/admin-ui/main.tsx"],
		entryNames: "[name]",
		format: "iife",
		globalName: "GeminiAccountAdminUi",
		jsx: "automatic",
		jsxImportSource: "preact",
		legalComments: "none",
		logLevel: "silent",
		minify: true,
		outdir: "admin-ui",
		platform: "browser",
		target: "es2025",
		write: false,
	});

	const js = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
	if (!js) {
		throw new Error("admin UI JavaScript bundle was not emitted");
	}

	const css = result.outputFiles.find((file) =>
		file.path.endsWith(".css"),
	)?.text;
	if (!css) {
		throw new Error("admin UI CSS bundle was not emitted");
	}

	const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemini Account Pool</title>
  <style>${css}</style>
</head>
<body>
  <div id="app"></div>
  <script>${js}</script>
</body>
</html>`;

	return { html };
}
