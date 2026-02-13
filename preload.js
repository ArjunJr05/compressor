const { ipcRenderer } = require('electron');

// When contextIsolation is false, we can attach directly to window
window.electronAPI = {
    compressVideo: (filePath, options, fileId) => ipcRenderer.invoke('compress-video', { filePath, options, fileId }),
    saveVideo: (filePath) => ipcRenderer.invoke('save-video', filePath),
    saveVideosToDownloads: (filePaths) => ipcRenderer.invoke('save-videos-to-downloads', filePaths),
    getVideoMetadata: (filePath) => ipcRenderer.invoke('get-video-metadata', filePath),
    onProgress: (callback) => ipcRenderer.on('compression-progress', (_event, data) => callback(data))
};
