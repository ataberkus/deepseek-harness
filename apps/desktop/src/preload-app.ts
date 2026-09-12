/** Startup controls for shell documents and OAuth URL opening for the application document. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  type DshDesktopApplicationApi,
  type DshDesktopStartupApi,
} from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'

const startup: DshDesktopStartupApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as ReturnType<DshDesktopStartupApi['locale']>,
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as ReturnType<DshDesktopStartupApi['backend']['status']>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  disablePlugins: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

const application: DshDesktopApplicationApi = {
  protocolVersion: 1,
  openOAuthUrl: url => ipcRenderer.invoke(DESKTOP_IPC.oauthOpen, url) as Promise<void>,
}

contextBridge.exposeInMainWorld('dshDesktop', location.protocol === 'dsh-app:'
  ? location.hostname === 'shell' ? startup : location.hostname === 'app' ? application : { protocolVersion: 1 }
  : { protocolVersion: 1 })
