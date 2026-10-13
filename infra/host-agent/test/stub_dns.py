#!/usr/bin/env python3
"""Stub DNS resolver for the veth-nat test: answers every A query with $ANSWER.
Runs inside the disposable "host" network namespace only. usage: stub_dns.py <answer-ip>"""
import socket, struct, sys
ans = socket.inet_aton(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", 53))
while True:
    q, addr = s.recvfrom(512)
    if len(q) < 12:
        continue
    i = 12
    while i < len(q) and q[i]:
        i += q[i] + 1
    question = q[12:i + 5]
    hdr = q[:2] + b"\x81\x80" + b"\x00\x01\x00\x01\x00\x00\x00\x00"
    rr = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 30, 4) + ans
    s.sendto(hdr + question + rr, addr)
