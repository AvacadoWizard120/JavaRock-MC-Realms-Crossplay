@echo off
setlocal
if not exist .env copy .env.example .env
npm install
npm run realm:probe
pause
