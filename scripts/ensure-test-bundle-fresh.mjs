import { existsSync, statSync } from "node:fs";
import { globSync } from "node:fs";
import { spawn } from "node:child_process";

const bundlePaths = ["dist/worker.test.js", "dist/worker.js"];
const sourceGlobs = ["src/**/*.ts", "scripts/build.mjs", "package.json", "tsconfig.json"];

if (needsBuild()) {
  await run(process.execPath, ["scripts/build.mjs", "--test-bundle"], process.env);
}

function needsBuild() {
  if (bundlePaths.some((path) => !existsSync(path))) return true;

  const oldestBundleMtime = Math.min(
    ...bundlePaths.map((path) => statSync(path).mtimeMs),
  );

  for (const pattern of sourceGlobs) {
    for (const path of globSync(pattern)) {
      if (statSync(path).mtimeMs > oldestBundleMtime) return true;
    }
  }
  return false;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${suffix}`));
    });
  });
}
