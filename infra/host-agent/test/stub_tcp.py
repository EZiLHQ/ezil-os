#!/usr/bin/env python3
"""Tiny TCP listener for the veth-nat test: accepts, writes 'ok', closes. usage: stub_tcp.py <port>"""
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", int(sys.argv[1])))
s.listen(16)
while True:
    c, _ = s.accept()
    try:
        c.sendall(b"ok\n")
    finally:
        c.close()
