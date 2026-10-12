@echo off
chcp 65001 >nul
title 安装Switch Armor插件
echo.
echo ======================================================
echo    DeepSeek 网络安全红队工具「Switch Armor」安装向导
echo ======================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo 按任意键退出...
pause >nul