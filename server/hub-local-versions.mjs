/**
 * Local FileFlows Server / Node DLL versions on the Hub (Plex) PC.
 */
import os from "node:os";
import path from "node:path";
import {
  firstExistingPath,
  readWindowsFileVersion,
} from "./windows-file-version.mjs";

function userProfile() {
  return process.env.USERPROFILE || os.homedir();
}

function programFiles() {
  return process.env["ProgramFiles"] || "C:\\Program Files";
}

function localAppData() {
  return (
    process.env.LOCALAPPDATA ||
    path.join(userProfile(), "AppData", "Local")
  );
}

function appData() {
  return process.env.APPDATA || path.join(userProfile(), "AppData", "Roaming");
}

export async function getHubLocalFileFlowsVersions() {
  const serverDll = firstExistingPath([
    path.join(appData(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(localAppData(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(programFiles(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(programFiles(), "FileFlows", "FileFlows.Server.dll"),
  ]);
  const nodeDll = firstExistingPath([
    path.join(appData(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(localAppData(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(programFiles(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(programFiles(), "FileFlows", "FileFlows.Node.dll"),
  ]);

  const [serverVersion, nodeVersion] = await Promise.all([
    readWindowsFileVersion(serverDll),
    readWindowsFileVersion(nodeDll),
  ]);

  return {
    fileflows: {
      version: serverVersion,
      path: serverDll || null,
    },
    "fileflows-node": {
      version: nodeVersion,
      path: nodeDll || null,
    },
  };
}
