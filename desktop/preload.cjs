const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('sdrDesktop', {
    platform: process.platform,
    getUpdateStatus: () => ipcRenderer.invoke('sdr:update-status'),
    checkForUpdates: () => ipcRenderer.invoke('sdr:update-check'),
    installUpdate: () => ipcRenderer.invoke('sdr:update-install'),
    continueStartup: () => ipcRenderer.send('sdr:update-continue'),
    onUpdateStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('sdr:update-status', listener); return () => ipcRenderer.removeListener('sdr:update-status', listener); },
    selectRtlLibrary: () => ipcRenderer.invoke('sdr:choose-library'),
    openIqRecordings: () => ipcRenderer.invoke('sdr:open-iq-recordings'),
    openReceiver: id => ipcRenderer.invoke('sdr:open-receiver', id),
    armMeshBluetooth: () => ipcRenderer.send('mesh:arm'),
    selectMeshBluetoothDevice: id => ipcRenderer.send('mesh:choose', id),
    respondMeshBluetoothPairing: response => ipcRenderer.send('mesh:pair-response', response),
    onMeshBluetoothDevices: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('mesh:devices', listener); return () => ipcRenderer.removeListener('mesh:devices', listener); },
    onMeshBluetoothPairing: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('mesh:pairing', listener); return () => ipcRenderer.removeListener('mesh:pairing', listener); },
    onNavigate: callback => { const listener = (_event, page) => callback(page); ipcRenderer.on('sdr:navigate', listener); return () => ipcRenderer.removeListener('sdr:navigate', listener); }
  });
}
