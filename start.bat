@echo off
chcp 65001 > nul
cd /d "%~dp0"
if not exist node_modules (
  echo 처음 실행: 필요한 패키지를 설치합니다...
  call npm install
)
start "" http://localhost:4300
node server.js
pause
