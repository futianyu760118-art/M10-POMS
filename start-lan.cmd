@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  M10 POMS 局域网演示启动器
echo ============================================
echo 正在启动服务器（0.0.0.0，可供其他电脑访问）...
echo 其他电脑访问地址见下方输出（http://<本机IP>:4173/）
echo 按 Ctrl+C 停止服务器。
echo.
node apps/bff/server.js
pause
