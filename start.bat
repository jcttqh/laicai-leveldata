@echo off
setlocal
title OutDoor Level Data H5 (Mobile) - LAN Server

rem ============================================================
rem  来财行动 · 关卡数据 H5（手机版）局域网启动器
rem  纯静态前端；本机作为服务器，手机连同一网络用浏览器打开即可。
rem  优先用 serve.py（会自动显示手机访问地址），否则回退到普通 http.server。
rem ============================================================

set "PORT=8150"
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    python serve.py
    goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
    py serve.py
    goto :end
)

rem ---- 回退：Node（npx serve），并提示查 IP ----
where npx >nul 2>nul
if %errorlevel%==0 (
    echo [start] Python not found. Using npx serve on port %PORT% ...
    echo         Phone (same Wi-Fi): http://YOUR_PC_LAN_IP:%PORT%/index.html
    echo         Run  ipconfig  to see this PC's IPv4 address.
    npx --yes serve -l %PORT%
    goto :end
)

echo.
echo [ERROR] Neither Python nor Node.js detected. Please install one:
echo           - Python : https://www.python.org/downloads/
echo           - Node.js : https://nodejs.org/
echo.
pause

:end
endlocal
