const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// FFmpeg download URLs - MINIMAL BUILDS with hardware encoder support
const FFMPEG_URLS = {
    // Minimal builds: h264 encoder (hw+sw), aac, mp4/mov only
    win32: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip',
    darwin: 'https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip', // Already minimal, includes VideoToolbox
    linux: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
};

class FFmpegDownloader {
    constructor(mainWindow = null) {
        this.ffmpegDir = path.join(app.getPath('userData'), 'ffmpeg');
        this.ffmpegPath = null;
        this.downloadPromise = null;
        this.mainWindow = mainWindow;
    }

    async ensureFFmpeg() {
        // Check if already downloaded
        const existingPath = this.getFFmpegPath();
        if (existingPath && fs.existsSync(existingPath)) {
            console.log('✅ FFmpeg already available at:', existingPath);
            this.ffmpegPath = existingPath;
            return existingPath;
        }

        // If download is already in progress, return the existing promise
        if (this.downloadPromise) {
            console.log('⏳ FFmpeg download already in progress, waiting...');
            return this.downloadPromise;
        }

        // Start download and cache the promise
        console.log('📥 FFmpeg not found, downloading...');
        
        // Notify renderer that download is starting
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('ffmpeg-download-start');
        }
        
        this.downloadPromise = this._performDownload()
            .finally(() => {
                // Clear promise after completion (success or failure)
                this.downloadPromise = null;
            });
        
        return this.downloadPromise;
    }

    async _performDownload() {
        await this.downloadFFmpeg();
        
        const downloadedPath = this.getFFmpegPath();
        if (!downloadedPath || !fs.existsSync(downloadedPath)) {
            throw new Error('FFmpeg download failed');
        }

        this.ffmpegPath = downloadedPath;
        console.log('✅ FFmpeg ready at:', downloadedPath);
        
        // Notify renderer that download is complete
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('ffmpeg-download-complete');
        }
        
        return downloadedPath;
    }

    getFFmpegPath() {
        if (!fs.existsSync(this.ffmpegDir)) {
            return null;
        }

        const platform = process.platform;
        let binaryName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        
        // Check direct path
        let ffmpegPath = path.join(this.ffmpegDir, binaryName);
        if (fs.existsSync(ffmpegPath)) {
            return ffmpegPath;
        }

        // Check in bin subdirectory
        ffmpegPath = path.join(this.ffmpegDir, 'bin', binaryName);
        if (fs.existsSync(ffmpegPath)) {
            return ffmpegPath;
        }

        return null;
    }

    async downloadFFmpeg() {
        const platform = process.platform;
        const url = FFMPEG_URLS[platform];
        
        if (!url) {
            throw new Error(`Unsupported platform: ${platform}`);
        }

        // Create ffmpeg directory
        if (!fs.existsSync(this.ffmpegDir)) {
            fs.mkdirSync(this.ffmpegDir, { recursive: true });
        }

        const tempFile = path.join(this.ffmpegDir, `ffmpeg-download${path.extname(url)}`);
        const lockFile = path.join(this.ffmpegDir, '.download.lock');
        
        // Check if another process is already downloading (cross-instance protection)
        if (fs.existsSync(lockFile)) {
            console.log('⏳ Another download is in progress (lock file exists), waiting...');
            // Wait for lock to be released (max 5 minutes)
            for (let i = 0; i < 300; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (!fs.existsSync(lockFile)) {
                    console.log('✅ Lock released, continuing...');
                    break;
                }
            }
        }
        
        // Create lock file
        try {
            fs.writeFileSync(lockFile, Date.now().toString());
        } catch (err) {
            console.warn('Failed to create lock file:', err);
        }
        
        try {
            console.log(`📥 Downloading FFmpeg from ${url}...`);
            await this.downloadFile(url, tempFile);
            
            console.log('📦 Extracting FFmpeg...');
            await this.extractFFmpeg(tempFile, this.ffmpegDir);
            
            // Clean up temp file
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }

            // Make executable on Unix systems
            if (platform !== 'win32') {
                const ffmpegPath = this.getFFmpegPath();
                if (ffmpegPath) {
                    await execPromise(`chmod +x "${ffmpegPath}"`);
                }
            }

            console.log('✅ FFmpeg extracted successfully');
        } finally {
            // Always remove lock file
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
            }
        }
    }

    downloadFile(url, destination) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            
            const request = client.get(url, (response) => {
                // Handle redirects
                if (response.statusCode === 301 || response.statusCode === 302) {
                    this.downloadFile(response.headers.location, destination)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`Download failed: ${response.statusCode}`));
                    return;
                }

                const totalBytes = parseInt(response.headers['content-length'], 10);
                let downloadedBytes = 0;

                const fileStream = fs.createWriteStream(destination);
                
                response.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                    process.stdout.write(`\r📥 Downloading: ${progress}%`);
                });

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log('\n✅ Download complete');
                    resolve();
                });

                fileStream.on('error', (err) => {
                    fs.unlinkSync(destination);
                    reject(err);
                });
            });

            request.on('error', reject);
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Download timeout'));
            });
        });
    }

    async extractFFmpeg(archivePath, destDir) {
        const platform = process.platform;

        if (platform === 'win32') {
            // Extract ZIP on Windows using PowerShell
            await execPromise(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`);
            
            // Move ffmpeg.exe from nested folder to root
            const files = fs.readdirSync(destDir);
            const extractedFolder = files.find(f => f.startsWith('ffmpeg-') && fs.statSync(path.join(destDir, f)).isDirectory());
            
            if (extractedFolder) {
                const binPath = path.join(destDir, extractedFolder, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(binPath)) {
                    fs.copyFileSync(binPath, path.join(destDir, 'ffmpeg.exe'));
                }
            }
        } else if (platform === 'darwin') {
            // Extract ZIP on macOS
            await execPromise(`unzip -o "${archivePath}" -d "${destDir}"`);
        } else {
            // Extract tar.xz on Linux
            await execPromise(`tar -xJf "${archivePath}" -C "${destDir}" --strip-components=1`);
        }
    }

    getPath() {
        return this.ffmpegPath;
    }
}

module.exports = { FFmpegDownloader };
