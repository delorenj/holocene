import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function restartGatewayAll() {
  const { stdout } = await execFileAsync("systemctl", [
    "--user",
    "list-unit-files",
    "hermes-*-gateway.service",
    "--no-legend"
  ]);
  const units = stdout
    .split("\n")
    .map((line: string) => line.trim().split(/\s+/)[0])
    .filter((u: string) => u.endsWith(".service"));

  for (const unit of units) {
    await execFileAsync("systemctl", ["--user", "restart", unit]);
  }

  return { restarted: units };
}
