#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
来财行动 · 关卡数据 H5（手机版）局域网启动器
------------------------------------------------
纯静态前端，无需公网 / 无需在手机上安装或解压任何东西。
运行后：本机作为服务器，手机连同一 Wi-Fi / 局域网，浏览器打开屏幕上显示的地址即可。

用法： python serve.py   （或双击 start.bat）
"""
import http.server
import socketserver
import socket
import threading
import webbrowser

PORT = 8150


def get_lan_ip():
    """获取本机在局域网中的 IPv4 地址（不依赖外网连通）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 静默日志，保持终端整洁


def main():
    lan_ip = get_lan_ip()
    phone_url = "http://%s:%d/index.html" % (lan_ip, PORT)
    local_url = "http://localhost:%d/index.html" % PORT

    line = "=" * 60
    print(line)
    print("  来财行动 · 关卡数据 H5（手机版） 已启动")
    print(line)
    print("  本机预览 : %s" % local_url)
    print()
    print("  >> 手机访问（连同一 Wi-Fi / 局域网）：")
    print("     %s" % phone_url)
    print()
    print("  提示：手机与本机需在同一网络；首次运行若弹出防火墙")
    print("        提示，请允许 Python 访问“专用/工作网络”。")
    print("        关闭本窗口即停止服务。")
    print(line)

    # 顺手在本机浏览器打开一份，方便先自检
    try:
        webbrowser.open(local_url)
    except Exception:
        pass

    # 绑定 0.0.0.0 让局域网内其它设备（手机）可访问
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
