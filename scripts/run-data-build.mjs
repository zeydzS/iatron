import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const candidates = [
  process.env.IATRON_PYTHON,
  "D:\\IazamedProject\\.tools\\python\\python.exe",
  "python",
].filter(Boolean);

for (const executable of candidates) {
  if (executable !== "python" && !existsSync(executable)) continue;
  const result = spawnSync(executable, ["scripts/build_data.py"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") continue;
  process.exit(result.status ?? 1);
}

throw new Error("Python 3 was not found. Set IATRON_PYTHON to a Python 3 executable.");
