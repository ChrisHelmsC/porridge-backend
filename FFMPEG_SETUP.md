# FFmpeg Setup for Video Thumbnails

The backend uses FFmpeg to generate video thumbnails automatically during upload.

## Installation

### macOS (using Homebrew)
```bash
brew install ffmpeg
```

### Ubuntu/Debian
```bash
sudo apt update
sudo apt install ffmpeg
```

### Windows
1. Download FFmpeg from https://ffmpeg.org/download.html
2. Extract to a folder (e.g., `C:\ffmpeg`)
3. Add `C:\ffmpeg\bin` to your PATH environment variable

### Docker (Production)
Add to your Dockerfile:
```dockerfile
RUN apt-get update && apt-get install -y ffmpeg
```

## Verification

Test that FFmpeg is installed correctly:
```bash
ffmpeg -version
```

## How it works

1. When a video file is uploaded, the system detects it's a video
2. FFmpeg generates a JPEG thumbnail at the 1-second mark
3. The thumbnail is uploaded to S3 in a `thumbnails/` folder
4. The frontend displays the thumbnail as the video poster image
5. Local temporary files are cleaned up automatically

## Thumbnail settings

- **Resolution**: 640x360 (16:9 aspect ratio)
- **Format**: JPEG
- **Timestamp**: 1 second into the video
- **Storage**: S3 bucket under `thumbnails/` prefix
