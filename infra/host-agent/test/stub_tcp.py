#!/usr/bin/env python3
"""Tiny TCP listener for the veth-nat test: accepts, writes 'ok', closes.
usage: stub_tcp.py <port> [peer-log] [v6]   (v6: listen on [::] dual-stack)"""
import socket, sys
port = int(sys.argv[1]); logf = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None
v6 = len(sys.argv) > 3 and sys.argv[3] == "v6"
s = socket.socket(socket.AF_INET6 if v6 else socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
if v6:
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
s.bind(("::" if v6 else "0.0.0.0", port))
s.listen(16)
while True:
    c, peer = s.accept()
    try:
        if logf:
            with open(logf, "a") as f:
                f.write(peer[0] + "\n")
        c.sendall(b"ok\n")
    finally:
        c.close()
