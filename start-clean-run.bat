@echo off
setlocal EnableExtensions EnableDelayedExpansion
title YouTube Downloader

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

deno run --allow-all api.ts

if errorlevel 1 (
    echo.
    echo [!] Server stopped with error
    pause
)