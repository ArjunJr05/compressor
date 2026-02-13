const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, shell } = electron;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { FFmpegDownloader } = require('./ffmpeg-downloader');

// Lazy load ffmpeg to avoid startup crashes if they are the cause
let ffmpeg = null;
let ffmpegPath = null;
let ffmpegDownloader = null;

async function initializeFFmpeg(mainWindow = null) {
    try {
        ffmpeg = require('fluent-ffmpeg');
        ffmpegDownloader = new FFmpegDownloader(mainWindow);
        
        // This will download FFmpeg if not present
        ffmpegPath = await ffmpegDownloader.ensureFFmpeg();
        
        ffmpeg.setFfmpegPath(ffmpegPath);
        console.log('✅ FFmpeg initialized at:', ffmpegPath);
        return true;
    } catch (e) {
        console.error('❌ Failed to initialize FFmpeg:', e);
        return false;
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            // Using less secure settings for local app compatibility/ease of use
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            enableRemoteModule: true /* deprecated but harmless here */
        }
    });

    win.loadFile('app.html');
    return win;
}

if (!app) {
    console.error('FATAL: app is undefined. Attempting to force require.');
    process.exit(1);
}

app.whenReady().then(async () => {
    console.log('App Ready');
    
    const mainWindow = createWindow();
    
    // Initialize FFmpeg in background (won't block app startup)
    initializeFFmpeg(mainWindow).catch(err => {
        console.error('FFmpeg initialization failed:', err);
    });
    
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Helper function to get video metadata using ffmpeg directly
async function getVideoMetadata(filePath) {
    try {
        const { stdout } = await execPromise(`"${ffmpegPath}" -i "${filePath}" -hide_banner 2>&1`);
        // Parse ffmpeg output to extract width, height, codec, bitrate
        return parseFFmpegOutput(stdout);
    } catch (error) {
        // FFmpeg exits with error code when just probing, but output is in stderr
        if (error.stdout || error.stderr) {
            return parseFFmpegOutput(error.stdout || error.stderr);
        }
        throw error;
    }
}

function parseFFmpegOutput(output) {
    const lines = output.split('\n');
    let width = 0, height = 0, codec = '', bitRate = 0;
    
    // Find the video stream line (e.g., "Stream #0:0: Video: h264...")
    for (const line of lines) {
        if (line.includes('Video:')) {
            // Extract codec
            const codecMatch = line.match(/Video:\s*(\w+)/);
            if (codecMatch) codec = codecMatch[1];
            
            // Extract resolution (e.g., "1920x1080")
            const resMatch = line.match(/(\d{2,5})x(\d{2,5})/);
            if (resMatch) {
                width = parseInt(resMatch[1]);
                height = parseInt(resMatch[2]);
            }
            
            // Extract bitrate (e.g., "1500 kb/s")
            const bitrateMatch = line.match(/(\d+)\s*kb\/s/);
            if (bitrateMatch) {
                bitRate = parseInt(bitrateMatch[1]) * 1000; // Convert to bps
            }
            break;
        }
    }
    
    if (width === 0 || height === 0) {
        console.error('Failed to parse FFmpeg output. Output was:');
        console.error(output);
        throw new Error('Could not parse video dimensions from ffmpeg output');
    }
    
    return {
        streams: [{
            codec_type: 'video',
            width,
            height,
            codec_name: codec,
            bit_rate: bitRate
        }]
    };
}

// IPC Handler for Compression
ipcMain.handle('compress-video', async (event, { filePath, options, fileId }) => {
    // Ensure FFmpeg is ready (will download if needed)
    if (!ffmpeg || !ffmpegPath) {
        const initialized = await initializeFFmpeg();
        if (!initialized) {
            throw new Error('FFmpeg is not available and could not be downloaded. Please check your internet connection.');
        }
    }

    if (!filePath) {
        throw new Error('File path is missing');
    }

    const outputName = `compressed_${path.basename(filePath, path.extname(filePath))}_${options.quality}.${options.format || 'mp4'}`;
    const outputPath = path.join(path.dirname(filePath), outputName);

    console.log(`Starting compression: ${filePath} -> ${outputPath}`);
    console.log('Options:', options);

    try {
        // Get video metadata first to make smart encoding decisions
        const metadata = await getVideoMetadata(filePath);
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        
        if (!videoStream) {
            throw new Error('No video stream found');
        }

        const width = videoStream.width;
        const height = videoStream.height;
        const totalPixels = width * height;

        console.log(`📹 Input: ${width}x${height} ${videoStream.codec_name} @ ${Math.round((videoStream.bit_rate || 0) / 1000)}kbps`);

        return new Promise((resolve, reject) => {

            let command = ffmpeg(filePath);

            // Apply logic based on options
            const quality = options.quality || '360';

            // Handle 'original' quality - just copy streams without re-encoding
            if (quality === 'original') {
                console.log('🎯 Preserving original quality (no re-encoding)');
                command.videoCodec('copy').audioCodec('copy');
            } else {
                // Rule-based compression strategy:
                // - 8K and above (7680x4320+): Use hardware acceleration with optimized settings
                // - 4K and below: Use fast software encoding (ultrafast preset, higher CRF)
                const is8K = totalPixels >= (7680 * 4320); // 8K or higher
                const is4K = totalPixels >= (3840 * 2160) && totalPixels < (7680 * 4320); // 4K
                const useHardwareAcceleration = is8K && process.platform === 'darwin';
                const useFastPreset = !is8K; // Use fast preset for 4K and below

                if (useHardwareAcceleration) {
                    console.log('🚀 8K Video: Using VideoToolbox hardware acceleration');
                    command.inputOptions(['-hwaccel', 'videotoolbox']);
                } else if (is4K) {
                    console.log('⚡ 4K Video: Using fast software encoding (ultrafast preset)');
                } else {
                    console.log('📦 Standard Video: Using fast encoding');
                }

                // Default audio
                command.audioCodec('aac').audioChannels(2).audioFrequency(44100);

                let height = 360;
                let videoBitrate = '400k';
                let audioBitrate = '64k';
                let maxWidth = 640;

                switch (quality) {
                    case '144':
                        height = 144;
                        maxWidth = 256;
                        videoBitrate = '100k';
                        audioBitrate = '32k';
                        break;
                    case '240':
                        height = 240;
                        maxWidth = 426;
                        videoBitrate = '200k';
                        audioBitrate = '48k';
                        break;
                    case '360':
                        height = 360;
                        maxWidth = 640;
                        videoBitrate = '400k';
                        audioBitrate = '64k';
                        break;
                    case '480':
                        height = 480;
                        maxWidth = 854;
                        videoBitrate = '600k';
                        audioBitrate = '96k';
                        break;
                    case '720':
                        height = 720;
                        maxWidth = 1280;
                        videoBitrate = '1000k';
                        audioBitrate = '128k';
                        break;
                    case '1080':
                        height = 1080;
                        maxWidth = 1920;
                        videoBitrate = '2000k';
                        audioBitrate = '128k';
                        break;
                }

                // Apply overrides if provided
                if (options.heightOverride) height = options.heightOverride;
                if (options.videoBitrateOverride) videoBitrate = options.videoBitrateOverride;
                if (options.audioBitrateOverride) audioBitrate = options.audioBitrateOverride;

                // Determine codec based on output format
                const isWebM = options.format === 'webm';

                // Hardware encoding FIRST (faster, lower CPU), software fallback
                if (isWebM) {
                    // WebM not supported in hardware - use software
                    command.videoCodec('libvpx-vp9');
                    command.addOption('-b:v', videoBitrate);
                    command.addOption('-crf', '30');
                    command.addOption('-cpu-used', '2');
                    command.audioCodec('libopus');
                    command.audioBitrate(audioBitrate);
                } else if (useHardwareAcceleration) {
                    // Hardware encoder for 8K+ videos (VideoToolbox on macOS)
                    // Note: VideoToolbox sets profile/level/pix_fmt automatically
                    command.videoCodec('h264_videotoolbox');
                    command.addOption('-b:v', videoBitrate);
                } else {
                    // Fast software encoder for 4K and below
                    command.videoCodec('libx264');
                    
                    if (useFastPreset) {
                        command.addOption('-preset', 'ultrafast');
                        command.addOption('-crf', '28'); 
                    } else {
                        command.addOption('-preset', 'veryfast');
                        command.addOption('-crf', '23');
                    }
                    
                    command.videoBitrate(videoBitrate);
                }

                // Preserve aspect ratio (portrait/landscape)
                command.size(`${maxWidth}x?`);

                // Adjust FPS based on resolution
                if (is8K) {
                    command.fps(24); // Reduce to 24fps for 8K
                } else if (is4K) {
                    command.fps(30); // 30fps for 4K
                } else {
                    command.fps(30); // Keep 30fps for smaller videos
                }

                // Format-specific options - only for software encoder
                if (!isWebM && !useHardwareAcceleration) {
                    // MP4-specific options (libx264 software encoder)
                    command.addOption('-profile:v', 'main');
                    command.addOption('-pix_fmt', 'yuv420p'); // Force 8-bit output
                    command.addOption('-level', '3.1');
                }
                
                // Fast start for all MP4 files
                if (!isWebM) {
                    command.addOption('-movflags', '+faststart');
                }
            }

            command
                .on('start', (commandLine) => {
                    console.log('Spawned Ffmpeg with command: ' + commandLine);
                })
                .on('progress', (progress) => {
                    if (progress.percent && event.sender) {
                        try {
                            event.sender.send('compression-progress', {
                                fileId: fileId || 'unknown',
                                percent: progress.percent
                            });
                        } catch (e) { }
                    }
                })
                .on('error', (err, stdout, stderr) => {
                    console.error('An error occurred: ' + err.message);
                    console.error('FFmpeg stderr:', stderr);
                    console.error('FFmpeg stdout:', stdout);
                    console.error('FFmpeg command failed');
                    reject(err.message);
                })
                .on('end', () => {
                    console.log('Processing finished successfully');
                    resolve({
                        outputName,
                        outputPath,
                        format: options.format || 'mp4'
                    });
                })
                .save(outputPath);
        });
    } catch (error) {
        console.error('Compression error:', error);
        throw new Error(`Compression failed: ${error.message}`);
    }
});

ipcMain.handle('save-video', async (event, sourcePath) => {
    const { filePath } = await dialog.showSaveDialog({
            defaultPath: path.basename(sourcePath),
            filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'avi'] }]
        });

        if (filePath) {
            const fs = require('fs');
            fs.copyFileSync(sourcePath, filePath);
            return true;
        }
        return false;
    });

ipcMain.handle('save-videos-to-downloads', async (_event, sourcePaths) => {
    const fs = require('fs');
    const downloadsDir = app.getPath('downloads');
    const savedPaths = [];

    const ensureUniquePath = (basePath) => {
        if (!fs.existsSync(basePath)) return basePath;
        const parsed = path.parse(basePath);
        let counter = 1;
        let candidate = '';
        do {
            candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
            counter += 1;
        } while (fs.existsSync(candidate));
        return candidate;
    };

    for (const sourcePath of sourcePaths || []) {
        if (!sourcePath) continue;
        const destination = ensureUniquePath(path.join(downloadsDir, path.basename(sourcePath)));
        try {
            fs.copyFileSync(sourcePath, destination);
            savedPaths.push(destination);
        } catch (e) {
            console.error('Failed to save to downloads:', e);
        }
    }

    if (savedPaths.length > 0) {
        shell.openPath(downloadsDir);
    }

    return savedPaths;
});

ipcMain.handle('get-video-metadata', async (_event, filePath) => {
    // Ensure FFmpeg is ready
    if (!ffmpeg || !ffmpegPath) {
        const initialized = await initializeFFmpeg();
        if (!initialized) {
            throw new Error('FFmpeg is not available');
        }
    }

    if (!filePath) {
        throw new Error('File path is missing');
    }

    try {
        const metadata = await getVideoMetadata(filePath);
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        
        if (!videoStream) {
            throw new Error('No video stream found');
        }

        const width = videoStream.width;
        const height = videoStream.height;
        const aspectRatio = width && height ? (width / height) : null;

        return { width, height, aspectRatio };
    } catch (error) {
        console.error('Failed to get video metadata:', error);
        throw error;
    }
});
