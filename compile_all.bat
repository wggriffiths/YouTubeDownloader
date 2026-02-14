@echo off
deno compile --allow-all --output ytdl-windows-x64.exe --target x86_64-pc-windows-msvc api.ts
deno compile --allow-all --output ytdl-linux-x64 --target x86_64-unknown-linux-gnu api.ts
deno compile --allow-all --output ytdl-macos-x64 --target x86_64-apple-darwin api.ts
deno compile --allow-all --output ytdl-macos-arm64 --target aarch64-apple-darwin api.ts
pause