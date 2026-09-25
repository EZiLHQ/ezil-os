/** Host ports are computer-scoped. Internal container ports remain untouched.
 * The AWS supervisor must reserve the same built-in ports before it binds
 * Browser, Code, CDP, the control API, and application services. */
export const RESERVED_COMPUTER_PORTS = new Set([
    3000, 3002, 4822, 5900, 5901, 8080, 8181, 8443, 9222, 9223,
]);
const FIRST_FALLBACK_PORT = 20_000;
const LAST_FALLBACK_PORT = 29_999;

export interface HostPortRequest {
    name: string;
    preferredHostPort?: number;
}

/** Call only after locking the computer row inside the installation
 * transaction, and back it with the database's unique computer/port index.
 * A host-level conflict discovered later fails the install job visibly. */
export function assignComputerHostPorts(
    services: readonly HostPortRequest[],
    leasedPorts: readonly number[],
): { name: string; hostPort: number }[] {
    const taken = new Set([...RESERVED_COMPUTER_PORTS, ...leasedPorts]);
    const assignments: { name: string; hostPort: number }[] = [];
    for (const service of services) {
        const preferred = service.preferredHostPort;
        if (preferred !== undefined && (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535)) {
            throw new Error('invalid_preferred_host_port');
        }
        let chosen = preferred !== undefined && !taken.has(preferred) ? preferred : undefined;
        if (chosen === undefined) {
            for (let port = FIRST_FALLBACK_PORT; port <= LAST_FALLBACK_PORT; port += 1) {
                if (!taken.has(port)) {
                    chosen = port;
                    break;
                }
            }
        }
        if (chosen === undefined) throw new Error('computer_host_ports_exhausted');
        taken.add(chosen);
        assignments.push({ name: service.name, hostPort: chosen });
    }
    return assignments;
}
