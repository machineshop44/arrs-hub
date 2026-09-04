/**
 * Local app versions on the Companion PC.
 */
import os from "node:os";
import path from "node:path";
import { detectFileFlowsInstalls } from "./fileflows-detect.mjs";
import {
  firstExistingPath,
  readWindowsFileVersion,
} from "../server/windows-file-version.mjs";

function userProfile() {
  return process.env.USERPROFILE || os.homedir();
}

function programFiles() {
  return process.env["ProgramFiles"] || "C:\\Program Files";
}

function programFilesX86() {
  return process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
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

function qbitExeCandidates() {
  return [
    path.join(programFiles(), "qBittorrent", "qbittorrent.exe"),
    path.join(programFilesX86(), "qBittorrent", "qbittorrent.exe"),
    path.join(localAppData(), "Programs", "qBittorrent", "qbittorrent.exe"),
  ];
}

function sabExeCandidates() {
  return [
    path.join(programFiles(), "SABnzbd", "SABnzbd.exe"),
    path.join(programFilesX86(), "SABnzbd", "SABnzbd.exe"),
    path.join(localAppData(), "sabnzbd", "SABnzbd.exe"),
    path.join(userProfile(), "AppData", "Local", "sabnzbd", "SABnzbd.exe"),
  ];
}

function surfsharkExeCandidates() {
  return [
    path.join(programFiles(), "Surfshark", "Surfshark.exe"),
    path.join(programFilesX86(), "Surfshark", "Surfshark.exe"),
    path.join(localAppData(), "Programs", "Surfshark", "Surfshark.exe"),
    path.join(localAppData(), "Surfshark", "Surfshark.exe"),
  ];
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   checkedAt: string,
 *   apps: Array<{
 *     id: string,
 *     label: string,
 *     version: string|null,
 *     path: string|null,
 *   }>
 * }>}
 */
export async function getLocalAppVersions() {
  const installs = detectFileFlowsInstalls();
  const node = installs.find((item) => item.role === "node");
  const server = installs.find((item) => item.role === "server");

  const nodeDll = firstExistingPath([
    node?.exeCwd ? path.join(node.exeCwd, "FileFlows.Node.dll") : "",
    path.join(appData(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(localAppData(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(programFiles(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(programFiles(), "FileFlows", "FileFlows.Node.dll"),
  ]);

  const serverDll = firstExistingPath([
    server?.exeCwd ? path.join(server.exeCwd, "FileFlows.Server.dll") : "",
    path.join(appData(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(localAppData(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(programFiles(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(programFiles(), "FileFlows", "FileFlows.Server.dll"),
  ]);

  const qbitExe = firstExistingPath(qbitExeCandidates());
  const sabExe = firstExistingPath(sabExeCandidates());
  const surfExe = firstExistingPath(surfsharkExeCandidates());

  const [
    fileflowsNodeVersion,
    fileflowsServerVersion,
    qbitVersion,
    sabVersion,
    surfVersion,
  ] = await Promise.all([
    readWindowsFileVersion(nodeDll),
    readWindowsFileVersion(serverDll),
    readWindowsFileVersion(qbitExe),
    readWindowsFileVersion(sabExe),
    readWindowsFileVersion(surfExe),
  ]);

  /** @type {Array<{id:string,label:string,version:string|null,path:string|null}>} */
  const apps = [
    {
      id: "qbittorrent",
      label: "qBittorrent",
      version: qbitVersion,
      path: qbitExe || null,
    },
    {
      id: "sabnzbd",
      label: "SABnzbd",
      version: sabVersion,
      path: sabExe || null,
    },
  ];

  if (nodeDll || fileflowsNodeVersion) {
    apps.push({
      id: "fileflows-node",
      label: "FileFlows Node",
      version: fileflowsNodeVersion,
      path: nodeDll || null,
    });
  }
  if (serverDll || fileflowsServerVersion) {
    apps.push({
      id: "fileflows",
      label: "FileFlows",
      version: fileflowsServerVersion,
      path: serverDll || null,
    });
  }
  if (surfExe || surfVersion) {
    apps.push({
      id: "surfshark",
      label: "Surfshark",
      version: surfVersion,
      path: surfExe || null,
    });
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    apps,
  };
}
