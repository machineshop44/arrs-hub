import path from "node:path";
import { spawn } from "node:child_process";

function splitExeArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const matches = text.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) return [];
  return matches.map((part) =>
    part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  );
}

export function startWindowsService(serviceName) {
  return new Promise((resolve) => {
    if (!serviceName?.trim()) {
      resolve({ ok: false, message: "No Windows service name configured" });
      return;
    }

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `try { Start-Service -Name '${serviceName.replace(/'/g, "''")}' -ErrorAction Stop; 'STARTED' } catch { $_.Exception.Message }`,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const output = (stdout || stderr).trim();
      if (code === 0 && output.includes("STARTED")) {
        resolve({
          ok: true,
          message: `Started Windows service "${serviceName}"`,
        });
      } else {
        resolve({
          ok: false,
          message: output || `Could not start service "${serviceName}"`,
        });
      }
    });
  });
}

export function startExeProcess(exePath, exeArgs, exeCwd) {
  return new Promise((resolve) => {
    const file = String(exePath || "").trim();
    if (!file) {
      resolve({ ok: false, message: "No exe path configured" });
      return;
    }

    const args = splitExeArgs(exeArgs);
    const cwd = String(exeCwd || "").trim() || path.dirname(file);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(file, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      child.on("error", (err) => {
        finish({
          ok: false,
          message: err?.message || `Could not start exe "${file}"`,
        });
      });
      child.unref();
      setTimeout(() => {
        finish({
          ok: true,
          message: `Started exe "${file}"${args.length ? ` ${args.join(" ")}` : ""}`,
        });
      }, 250);
    } catch (err) {
      finish({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Prefer Windows service; if that fails or no service name, try optional exe.
 * @param {{ windowsService?: string, exePath?: string, exeArgs?: string, exeCwd?: string }} serviceCfg
 */
export async function restartServiceOrExe(serviceCfg) {
  const serviceName = String(serviceCfg.windowsService || "").trim();
  const exePath = String(serviceCfg.exePath || "").trim();

  if (serviceName) {
    const serviceResult = await startWindowsService(serviceName);
    if (serviceResult.ok) return serviceResult;
    if (exePath) {
      const exeResult = await startExeProcess(
        exePath,
        serviceCfg.exeArgs,
        serviceCfg.exeCwd,
      );
      return {
        ok: exeResult.ok,
        message: `${serviceResult.message}; exe fallback: ${exeResult.message}`,
      };
    }
    return serviceResult;
  }

  if (exePath) {
    return startExeProcess(exePath, serviceCfg.exeArgs, serviceCfg.exeCwd);
  }

  return {
    ok: false,
    message: "No Windows service name or exe path configured",
  };
}
