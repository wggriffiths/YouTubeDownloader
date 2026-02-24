@echo off
deno compile --allow-all --include public/ --output ytdl api.ts
pause