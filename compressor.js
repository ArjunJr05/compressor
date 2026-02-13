export class Compressor {
  constructor() {
    this.loaded = true;
  }

  async load(onProgress = null) {
    if (onProgress) onProgress('Ready');
    return;
  }

  formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }


  async compress(file, options = {}, onProgress = null, fileId = null) {
    return new Promise(async (resolve, reject) => {
      try {
        // Setup progress listener
        if (onProgress && fileId) {
          window.electronAPI.onProgress((data) => {
            // Only process progress for this specific file
            if (data.fileId === fileId && typeof data.percent === 'number') {
              onProgress({ status: 'Compressing...', progress: data.percent });
            }
          });
        }

        console.log('--- DEBUG: File Object ---');
        console.log(file);
        console.log('file.path:', file.path);
        console.log('file.name:', file.name);

        let filePath = file.path;

        if (!filePath) {
          console.log('file.path is empty. Trying electron.webUtils...');
          try {
            if (typeof require !== 'undefined') {
              const { webUtils } = require('electron');
              filePath = webUtils.getPathForFile(file);
              console.log('webUtils returned:', filePath);
            } else if (window.require) {
              const { webUtils } = window.require('electron');
              filePath = webUtils.getPathForFile(file);
              console.log('window.require webUtils returned:', filePath);
            }
          } catch (e) {
            console.warn('Failed to use webUtils:', e);
          }
        }

        console.log(`Final filePath to send: ${filePath}`);

        if (!filePath) {
          const errorMsg = 'Could not determine file path. Please try selecting the file again via the "Choose File" button.';
          alert(errorMsg);
          throw new Error(errorMsg);
        }

        const result = await window.electronAPI.compressVideo(filePath, options, fileId);

        console.log('Main process returned:', result);

        // Determine compressed file size if possible
        let compressedSize = 0;
        try {
          const fs = require('fs');
          const stats = fs.statSync(result.outputPath);
          compressedSize = stats.size;
        } catch (e) {
          console.warn('Could not determine compressed file size:', e);
        }

        resolve({
          filePath: result.outputPath,
          fileName: result.outputName,
          originalSize: file.size,
          compressedSize: compressedSize,
          format: options.format || 'mp4'
        });

      } catch (error) {
        console.error('Compression error:', error);
        reject(error);
      }
    });
  }
}