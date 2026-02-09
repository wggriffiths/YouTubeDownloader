@echo off
setlocal EnableExtensions EnableDelayedExpansion
title YouTube Downloader

REM ==================================================
REM YouTube Downloader - Auto Setup
REM ==================================================

cd /d %~dp0

echo.
echo ========================================
echo   YouTube Downloader - Auto Setup
echo ========================================
echo.

REM --------------------------------------------------
REM Create directories
REM --------------------------------------------------
if not exist "bin" mkdir "bin"
if not exist "public" mkdir "public"
if not exist "downloads" mkdir "downloads"

REM --------------------------------------------------
REM Check for ytdl.exe
REM --------------------------------------------------
if not exist "ytdl.exe" (
    echo ERROR: ytdl.exe not found
    echo.
    echo Please run:
    echo   deno compile --allow-all --output ytdl api.ts
    echo.
    pause
    exit /b 1
)
echo [+] Found ytdl.exe

REM --------------------------------------------------
REM Check for yt-dlp.exe
REM --------------------------------------------------
if not exist "bin\yt-dlp.exe" (
    echo [*] Downloading yt-dlp.exe...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " ^
      "Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'bin\yt-dlp.exe'"

    if errorlevel 1 (
        echo ERROR: yt-dlp download failed
        pause
        exit /b 1
    )
    echo [+] Downloaded yt-dlp.exe
) else (
    echo [+] Found yt-dlp.exe
)

REM --------------------------------------------------
REM FFmpeg sanity check
REM --------------------------------------------------
set "NEED_FFMPEG=0"

if exist "bin\ffmpeg.exe" (
    "bin\ffmpeg.exe" -version >nul 2>&1
    if errorlevel 1 (
        echo [!] ffmpeg.exe exists but is broken - re-downloading
        del /f /q "bin\ffmpeg.exe" >nul 2>&1
        set "NEED_FFMPEG=1"
    )
) else (
    set "NEED_FFMPEG=1"
)

if "%NEED_FFMPEG%"=="1" (
    echo [*] Downloading ffmpeg...

    REM Clean temp leftovers (critical)
    del /f /q "%TEMP%\ffmpeg.zip" >nul 2>&1
    rmdir /s /q "%TEMP%\ffmpeg_extract" >nul 2>&1

    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " ^
      "Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile $env:TEMP+'\ffmpeg.zip'"

    if not exist "%TEMP%\ffmpeg.zip" (
        echo ERROR: ffmpeg download failed
        pause
        exit /b 1
    )

    echo [*] Extracting ffmpeg...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "Expand-Archive -LiteralPath $env:TEMP+'\ffmpeg.zip' -DestinationPath $env:TEMP+'\ffmpeg_extract' -Force"

    if errorlevel 1 (
        echo ERROR: PowerShell extraction failed
        pause
        exit /b 1
    )

    echo [*] Locating ffmpeg.exe...
    for /r "%TEMP%\ffmpeg_extract" %%f in (ffmpeg.exe) do (
        echo [*] Found: %%f
        copy /y "%%f" "bin\ffmpeg.exe" >nul
        goto :ffmpeg_done
    )

    echo ERROR: ffmpeg.exe not found after extraction
    pause
    exit /b 1
)

:ffmpeg_done
echo [+] ffmpeg ready

REM --------------------------------------------------
REM Environment
REM --------------------------------------------------
set "YT_DLP_PATH=%~dp0bin\yt-dlp.exe"
set "PATH=%~dp0bin;%PATH%"

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

ytdl.exe

if errorlevel 1 (
    echo.
    echo Server stopped with error
    pause
)
