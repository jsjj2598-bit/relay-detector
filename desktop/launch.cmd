@echo off
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   未找到 Node.js。
  echo   请先安装 Node.js 21 或更高版本：https://nodejs.org/
  echo   安装后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)
node "desktop\launch.mjs"
if errorlevel 1 pause
