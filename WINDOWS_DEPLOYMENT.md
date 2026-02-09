# 🪟 Windows Deployment Guide

## Quick Start (Easiest Method)

### 1. Compile the Binary

```powershell
# In PowerShell, navigate to project folder
cd C:\ytdl

# Compile
deno compile --allow-all --output ytdl.exe api.ts
```

**Result:** `ytdl.exe` created (~55MB)

---

### 2. Run the Startup Script

**Option A: Simple (No Admin)**
```cmd
start-simple.bat
```

**Option B: With UAC (Admin)**
```cmd
start.bat
```

**That's it!** The script will:
- ✅ Auto-download yt-dlp.exe (if missing)
- ✅ Auto-download ffmpeg.exe (if missing)
- ✅ Create required folders
- ✅ Set environment variables
- ✅ Start the server

**Visit:** `http://localhost:8000`

---

## What Each Script Does

### `start.bat` (Admin Version)
- Requests UAC elevation (admin rights)
- Downloads dependencies to Program Files (if needed)
- Better for system-wide installation

**Use when:**
- Installing for all users
- Want persistent system PATH changes

---

### `start-simple.bat` (User Version)
- No admin required
- Downloads to local bin folder
- Portable installation

**Use when:**
- Single user installation
- Don't have admin rights
- Portable USB deployment

---

## Manual Setup (If Scripts Fail)

### Step 1: Download Dependencies

**yt-dlp:**
```
https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
```
Save to: `C:\ytdl\bin\yt-dlp.exe`

**ffmpeg:**
```
https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip
```
Extract `ffmpeg.exe` to: `C:\ytdl\bin\ffmpeg.exe`

---

### Step 2: Create Directory Structure

```
C:\ytdl\
├── ytdl.exe              (compiled binary)
├── api.ts                (source - optional to keep)
├── public\
│   └── index.html
├── downloads\            (auto-created)
└── bin\
    ├── yt-dlp.exe
    └── ffmpeg.exe
```

---

### Step 3: Create start.bat Manually

```batch
@echo off
cd /d %~dp0
set YT_DLP_PATH=%~dp0bin\yt-dlp.exe
set PATH=%~dp0bin;%PATH%
ytdl.exe
pause
```

Save as `start.bat` in `C:\ytdl\`

---

## Troubleshooting

### "ytdl.exe not found"

**Fix:**
```powershell
# Compile the binary first
deno compile --allow-all --output ytdl.exe api.ts
```

---

### "PowerShell execution policy error"

**Fix:**
```powershell
# Run as Administrator
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

### "Download failed"

**Possible causes:**
- No internet connection
- Firewall blocking PowerShell
- GitHub rate limit

**Fix:**
Download manually and place in `bin\` folder.

---

### "Cannot find yt-dlp"

**Fix:**
```batch
# Set explicit path
set YT_DLP_PATH=C:\ytdl\bin\yt-dlp.exe
ytdl.exe
```

---

### "ffmpeg not working"

**Fix:**
```cmd
# Test ffmpeg
C:\ytdl\bin\ffmpeg.exe -version

# If it doesn't work, re-download:
# https://github.com/BtbN/FFmpeg-Builds/releases
```

---

## Running as Windows Service (Advanced)

### Using NSSM (Non-Sucking Service Manager)

**1. Download NSSM:**
```
https://nssm.cc/download
```

**2. Install Service:**
```cmd
nssm install YouTubeDownloader "C:\ytdl\ytdl.exe"
nssm set YouTubeDownloader AppDirectory "C:\ytdl"
nssm set YouTubeDownloader AppEnvironmentExtra YT_DLP_PATH=C:\ytdl\bin\yt-dlp.exe
nssm start YouTubeDownloader
```

**3. Manage Service:**
```cmd
nssm start YouTubeDownloader
nssm stop YouTubeDownloader
nssm restart YouTubeDownloader
nssm remove YouTubeDownloader
```

---

## Firewall Configuration

**Allow port 8000:**
```powershell
# Run as Administrator
New-NetFirewallRule -DisplayName "YouTube Downloader" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
```

---

## Accessing from Other Devices

**From phone/tablet on same network:**
```
http://YOUR-PC-IP:8000
```

**Find your IP:**
```cmd
ipconfig | findstr IPv4
```

Example: `http://192.168.1.100:8000`

---

## Auto-Start on Windows Boot

**Option 1: Startup Folder**
```cmd
# Press Win+R, type: shell:startup
# Create shortcut to start.bat
# Place shortcut in Startup folder
```

**Option 2: Task Scheduler**
```cmd
# 1. Open Task Scheduler
# 2. Create Basic Task
# 3. Trigger: At log on
# 4. Action: Start program
# 5. Program: C:\ytdl\start.bat
```

**Option 3: Windows Service (Best)**
Use NSSM method above.

---

## Updating

### Update yt-dlp
```powershell
# Delete old version
del C:\ytdl\bin\yt-dlp.exe

# Run start.bat - it will auto-download latest
start.bat
```

### Update ytdl.exe
```powershell
# Recompile
deno compile --allow-all --output ytdl.exe api.ts
```

### Update ffmpeg
```powershell
# Delete old version
del C:\ytdl\bin\ffmpeg.exe

# Run start.bat - it will auto-download latest
start.bat
```

---

## Portable Deployment (USB Drive)

**1. Copy entire folder to USB:**
```
E:\ytdl\
├── ytdl.exe
├── start-simple.bat
├── public\
│   └── index.html
└── bin\
    ├── yt-dlp.exe
    └── ffmpeg.exe
```

**2. Run from any PC:**
```cmd
E:\ytdl\start-simple.bat
```

**3. Downloads go to:**
```
E:\ytdl\downloads\
```

---

## Performance Tips

### 1. Exclude from Antivirus
Add to Windows Defender exclusions:
```
C:\ytdl\
```

### 2. Use SSD
Move `downloads\` folder to SSD for faster processing.

### 3. Increase Priority
```powershell
# Start with high priority
Start-Process -FilePath "C:\ytdl\ytdl.exe" -Verb RunAs -Priority High
```

---

## Uninstall

**1. Stop service (if running)**
```cmd
nssm stop YouTubeDownloader
nssm remove YouTubeDownloader confirm
```

**2. Remove firewall rule**
```powershell
Remove-NetFirewallRule -DisplayName "YouTube Downloader"
```

**3. Delete folder**
```cmd
rmdir /s /q C:\ytdl
```

---

## File Sizes

| File | Size | Purpose |
|------|------|---------|
| ytdl.exe | ~55MB | Main application |
| yt-dlp.exe | ~10MB | YouTube downloader |
| ffmpeg.exe | ~120MB | Media converter |
| **Total** | **~185MB** | Complete installation |

---

## Security Notes

**Safe to use:**
- ✅ All binaries from official GitHub releases
- ✅ Scripts verify download sources
- ✅ No external dependencies
- ✅ Runs locally (no cloud)

**Antivirus warnings:**
- Some AVs flag yt-dlp.exe (false positive)
- Add to exclusions if needed
- All files are open source and verified

---

## Summary

**Easiest deployment:**
1. `deno compile --allow-all --output ytdl.exe api.ts`
2. Run `start-simple.bat`
3. Visit `http://localhost:8000`

**Dependencies auto-download on first run!** 🚀

---

## Support

**If scripts don't work:**
1. Download binaries manually
2. Place in `bin\` folder
3. Use simple manual start.bat:
   ```batch
   @echo off
   set YT_DLP_PATH=%~dp0bin\yt-dlp.exe
   ytdl.exe
   ```

**Everything is portable and self-contained!**
