@echo off
setlocal EnableExtensions EnableDelayedExpansion
title YouTube Downloader

REM Get script directory
set "PPATH=%~dp0"
cd /d "%PPATH%"

echo.
echo ========================================
echo   YouTube Downloader - Auto Setup
echo ========================================
echo.

REM Create directories
if not exist "%PPATH%bin" mkdir "%PPATH%bin"
if not exist "%PPATH%public" mkdir "%PPATH%public"
if not exist "%PPATH%downloads" mkdir "%PPATH%downloads"

REM --------------------------------------------------
REM Download ytdl.exe from GitHub if missing
REM --------------------------------------------------
if exist "%PPATH%ytdl.exe" goto :have_ytdl

echo [*] Downloading ytdl.exe from GitHub...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $url='https://github.com/wggriffiths/YouTube-Media-Downloader/releases/download/v1.0.0/ytdl-windows-x64.exe'; Write-Host '[*] Downloading...'; Invoke-WebRequest -Uri $url -OutFile '%PPATH%ytdl.exe' -UseBasicParsing; if (Test-Path '%PPATH%ytdl.exe') { Write-Host '[+] Downloaded ytdl.exe' } else { exit 1 }"

if errorlevel 1 (
    echo [!] Download failed
    echo Please download manually from:
    echo https://github.com/wggriffiths/YouTube-Media-Downloader/releases/latest
    pause
    exit /b 1
)

if not exist "%PPATH%ytdl.exe" (
    echo [!] ytdl.exe not found after download
    pause
    exit /b 1
)

:have_ytdl
echo [+] Found ytdl.exe

REM --------------------------------------------------
REM Download yt-dlp.exe
REM --------------------------------------------------
if exist "%PPATH%bin\yt-dlp.exe" goto :have_ytdlp

echo [*] Downloading yt-dlp.exe...
curl -L -o "%PPATH%bin\yt-dlp.exe" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe

if errorlevel 1 (
    echo [!] Download failed
    pause
    exit /b 1
)

echo [+] Downloaded yt-dlp.exe

:have_ytdlp
echo [+] Found yt-dlp.exe

REM --------------------------------------------------
REM Download ffmpeg
REM --------------------------------------------------
if exist "%PPATH%bin\ffmpeg.exe" goto :have_ffmpeg

echo [*] Downloading ffmpeg ^(120MB^)...
curl -L -o "%TEMP%\ffmpeg.zip" https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip

if not exist "%TEMP%\ffmpeg.zip" (
    echo [!] Download failed
    pause
    exit /b 1
)

echo [+] Downloaded ffmpeg.zip
echo [*] Extracting...

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%TEMP%\ffmpeg.zip' -DestinationPath '%TEMP%\ffmpeg_extract' -Force"

if errorlevel 1 (
    echo [!] Extraction failed
    del "%TEMP%\ffmpeg.zip" >nul 2>&1
    pause
    exit /b 1
)

echo [*] Locating ffmpeg.exe...

REM Find ffmpeg.exe in the nested folders (suppress copy errors)
for /r "%TEMP%\ffmpeg_extract" %%f in (ffmpeg.exe) do (
    copy /y "%%f" "%PPATH%bin\ffmpeg.exe" >nul 2>&1
    if exist "%PPATH%bin\ffmpeg.exe" (
        echo [+] Copied ffmpeg.exe successfully
        goto :cleanup_ffmpeg
    )
)

echo [!] ERROR: ffmpeg.exe not found in archive
del "%TEMP%\ffmpeg.zip" >nul 2>&1
rmdir /s /q "%TEMP%\ffmpeg_extract" >nul 2>&1
pause
exit /b 1

:cleanup_ffmpeg
del "%TEMP%\ffmpeg.zip" >nul 2>&1
rmdir /s /q "%TEMP%\ffmpeg_extract" >nul 2>&1

if not exist "%PPATH%bin\ffmpeg.exe" (
    echo [!] ERROR: ffmpeg.exe was not copied to bin
    pause
    exit /b 1
)

echo [+] ffmpeg ready

:have_ffmpeg
echo [+] Found ffmpeg.exe

REM --------------------------------------------------
REM Set environment
REM --------------------------------------------------
set "YT_DLP_PATH=%PPATH%bin\yt-dlp.exe"
set "PATH=%PPATH%bin;%PATH%"

REM --------------------------------------------------
REM Start server
REM --------------------------------------------------
echo.
echo ========================================
echo   Starting Server
echo ========================================
echo.
echo Open: http://localhost:8000
echo Press Ctrl+C to stop
echo.

"%PPATH%ytdl.exe"

if errorlevel 1 (
    echo.
    echo [!] Server stopped with error
    pause
)