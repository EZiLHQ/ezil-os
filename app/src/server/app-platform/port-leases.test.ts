import { describe, expect, it } from 'vitest';

import { assignComputerHostPorts, RESERVED_COMPUTER_PORTS } from './port-leases';

describe('computer-scoped host-port leases', () => {
    it('keeps an available preferred port and does not change the application’s internal port', () => {
        expect(assignComputerHostPorts([{ name: 'reticle', preferredHostPort: 4400 }], []))
            .toEqual([{ name: 'reticle', hostPort: 4400 }]);
    });

    it('uses the lowest free fallback for a collision, including within one install', () => {
        expect(assignComputerHostPorts([
            { name: 'first', preferredHostPort: 4400 },
            { name: 'second', preferredHostPort: 4400 },
            { name: 'third' },
        ], [4400, 20000])).toEqual([
            { name: 'first', hostPort: 20001 },
            { name: 'second', hostPort: 20002 },
            { name: 'third', hostPort: 20003 },
        ]);
    });

    it('never assigns infrastructure ports, even when requested', () => {
        for (const port of RESERVED_COMPUTER_PORTS) {
            expect(assignComputerHostPorts([{ name: 'service', preferredHostPort: port }], []))
                .toEqual([{ name: 'service', hostPort: 20000 }]);
        }
    });

    it('allows the same port on independent computers and rejects invalid requests', () => {
        expect(assignComputerHostPorts([{ name: 'web', preferredHostPort: 4400 }], []))
            .toEqual(assignComputerHostPorts([{ name: 'web', preferredHostPort: 4400 }], []));
        expect(() => assignComputerHostPorts([{ name: 'web', preferredHostPort: 80 }], []))
            .toThrow('invalid_preferred_host_port');
        expect(() => assignComputerHostPorts([{ name: 'web', preferredHostPort: 4400.5 }], []))
            .toThrow('invalid_preferred_host_port');
    });

    it('fails visibly when every fallback is leased', () => {
        const full = Array.from({ length: 10_000 }, (_, index) => index + 20_000);
        expect(() => assignComputerHostPorts([{ name: 'web', preferredHostPort: 3000 }], full))
            .toThrow('computer_host_ports_exhausted');
    });
});
